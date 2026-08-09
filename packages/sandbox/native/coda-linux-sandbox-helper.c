#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__)
#define CODA_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define CODA_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "coda-linux-sandbox-helper supports x86_64 and aarch64 only"
#endif

static void fail(const char *message) {
    fprintf(stderr, "coda linux sandbox: %s: %s\n", message, strerror(errno));
    _exit(126);
}

static void write_all(int fd, const char *buffer, size_t length) {
    while (length > 0) {
        ssize_t written = write(fd, buffer, length);
        if (written < 0) {
            if (errno == EINTR) continue;
            _exit(1);
        }
        buffer += written;
        length -= (size_t)written;
    }
}

static void relay_connection(int client, const char *socket_path) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) _exit(1);
    if (getppid() == 1) _exit(1);
    int upstream = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (upstream < 0) _exit(1);
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof(address.sun_path)) _exit(1);
    memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
    if (connect(upstream, (struct sockaddr *)&address, sizeof(address)) < 0) _exit(1);

    struct pollfd descriptors[2] = {
        {.fd = client, .events = POLLIN},
        {.fd = upstream, .events = POLLIN},
    };
    char buffer[16384];
    for (;;) {
        int ready = poll(descriptors, 2, -1);
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }
        for (int index = 0; index < 2; index++) {
            if ((descriptors[index].revents & (POLLIN | POLLHUP)) == 0) continue;
            int source = descriptors[index].fd;
            int destination = descriptors[index == 0 ? 1 : 0].fd;
            ssize_t received = read(source, buffer, sizeof(buffer));
            if (received <= 0) goto done;
            write_all(destination, buffer, (size_t)received);
        }
    }
done:
    close(client);
    close(upstream);
    _exit(0);
}

static void bring_loopback_up(void) {
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) fail("could not open loopback control socket");
    struct ifreq request;
    memset(&request, 0, sizeof(request));
    strncpy(request.ifr_name, "lo", IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFFLAGS, &request) < 0) fail("could not read loopback flags");
    if ((request.ifr_flags & IFF_UP) != IFF_UP) {
        request.ifr_flags |= IFF_UP;
        if (ioctl(fd, SIOCSIFFLAGS, &request) < 0) fail("could not enable loopback");
    }
    close(fd);
}

static void drop_capabilities(void) {
    for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
        int present = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
        if (present < 0) {
            if (errno == EINVAL) continue;
            fail("could not inspect capability bounding set");
        }
        if (present == 0) continue;
        if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) < 0) {
            fail("could not clear capability bounding set");
        }
        if (prctl(PR_CAPBSET_READ, capability, 0, 0, 0) != 0) {
            fail("could not verify capability bounding set");
        }
    }
    struct __user_cap_header_struct header = {
        .version = _LINUX_CAPABILITY_VERSION_3,
        .pid = 0,
    };
    struct __user_cap_data_struct capabilities[_LINUX_CAPABILITY_U32S_3];
    memset(capabilities, 0, sizeof(capabilities));
    if (syscall(SYS_capset, &header, capabilities) < 0) fail("could not clear process capabilities");
#if defined(PR_CAP_AMBIENT) && defined(PR_CAP_AMBIENT_CLEAR_ALL)
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0 && errno != EINVAL) {
        fail("could not clear ambient capabilities");
    }
#endif
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("PR_SET_NO_NEW_PRIVS failed");
}

static void run_proxy_bridge(const char *socket_path, uint16_t port) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) fail("could not bind proxy lifetime to command");
    if (getppid() == 1) _exit(1);
    drop_capabilities();
    signal(SIGCHLD, SIG_IGN);
    int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listener < 0) fail("could not open managed proxy listener");
    int enabled = 1;
    if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) < 0) {
        fail("could not configure managed proxy listener");
    }
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0) fail("could not bind managed proxy listener");
    if (listen(listener, 64) < 0) fail("could not listen for managed proxy clients");
    for (;;) {
        int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
        if (client < 0) {
            if (errno == EINTR) continue;
            fail("managed proxy accept failed");
        }
        pid_t child = fork();
        if (child < 0) {
            close(client);
            continue;
        }
        if (child == 0) {
            close(listener);
            relay_connection(client, socket_path);
        }
        close(client);
    }
}

static void append_deny(struct sock_filter *filter, size_t *length, int syscall_number) {
    filter[(*length)++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)syscall_number, 0, 1);
    filter[(*length)++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
}

static void install_seccomp(void) {
    int blocked[64];
    size_t blocked_count = 0;
#define BLOCK_SYSCALL(name) do { blocked[blocked_count++] = SYS_##name; } while (0)
#ifdef SYS_mount
    BLOCK_SYSCALL(mount);
#endif
#ifdef SYS_umount2
    BLOCK_SYSCALL(umount2);
#endif
#ifdef SYS_pivot_root
    BLOCK_SYSCALL(pivot_root);
#endif
#ifdef SYS_ptrace
    BLOCK_SYSCALL(ptrace);
#endif
#ifdef SYS_kexec_load
    BLOCK_SYSCALL(kexec_load);
#endif
#ifdef SYS_open_by_handle_at
    BLOCK_SYSCALL(open_by_handle_at);
#endif
#ifdef SYS_init_module
    BLOCK_SYSCALL(init_module);
#endif
#ifdef SYS_finit_module
    BLOCK_SYSCALL(finit_module);
#endif
#ifdef SYS_delete_module
    BLOCK_SYSCALL(delete_module);
#endif
#ifdef SYS_bpf
    BLOCK_SYSCALL(bpf);
#endif
#ifdef SYS_userfaultfd
    BLOCK_SYSCALL(userfaultfd);
#endif
#ifdef SYS_perf_event_open
    BLOCK_SYSCALL(perf_event_open);
#endif
#ifdef SYS_keyctl
    BLOCK_SYSCALL(keyctl);
#endif
#ifdef SYS_add_key
    BLOCK_SYSCALL(add_key);
#endif
#ifdef SYS_request_key
    BLOCK_SYSCALL(request_key);
#endif
#ifdef SYS_reboot
    BLOCK_SYSCALL(reboot);
#endif
#ifdef SYS_swapon
    BLOCK_SYSCALL(swapon);
#endif
#ifdef SYS_swapoff
    BLOCK_SYSCALL(swapoff);
#endif
#ifdef SYS_setns
    BLOCK_SYSCALL(setns);
#endif
#ifdef SYS_unshare
    BLOCK_SYSCALL(unshare);
#endif
#ifdef SYS_iopl
    BLOCK_SYSCALL(iopl);
#endif
#ifdef SYS_ioperm
    BLOCK_SYSCALL(ioperm);
#endif
#ifdef SYS_process_vm_writev
    BLOCK_SYSCALL(process_vm_writev);
#endif
#ifdef SYS_move_mount
    BLOCK_SYSCALL(move_mount);
#endif
#ifdef SYS_fsopen
    BLOCK_SYSCALL(fsopen);
#endif
#ifdef SYS_fsconfig
    BLOCK_SYSCALL(fsconfig);
#endif
#ifdef SYS_fsmount
    BLOCK_SYSCALL(fsmount);
#endif
#ifdef SYS_open_tree
    BLOCK_SYSCALL(open_tree);
#endif
#ifdef SYS_mount_setattr
    BLOCK_SYSCALL(mount_setattr);
#endif
#ifdef SYS_io_uring_setup
    BLOCK_SYSCALL(io_uring_setup);
#endif
#ifdef SYS_io_uring_enter
    BLOCK_SYSCALL(io_uring_enter);
#endif
#ifdef SYS_io_uring_register
    BLOCK_SYSCALL(io_uring_register);
#endif
#ifdef SYS_pidfd_getfd
    BLOCK_SYSCALL(pidfd_getfd);
#endif
#ifdef SYS_name_to_handle_at
    BLOCK_SYSCALL(name_to_handle_at);
#endif
#undef BLOCK_SYSCALL

    struct sock_filter filter[4 + 4 + 2 * 64 + 1];
    size_t length = 0;
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
    filter[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CODA_AUDIT_ARCH, 1, 0);
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#ifdef SYS_socket
    filter[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 3);
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
    filter[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1);
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#endif
    for (size_t index = 0; index < blocked_count; index++) append_deny(filter, &length, blocked[index]);
    filter[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
    struct sock_fprog program = {.len = (unsigned short)length, .filter = filter};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("PR_SET_NO_NEW_PRIVS failed");
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) fail("seccomp installation failed");
}

int main(int argc, char **argv) {
    const char *socket_path = NULL;
    uint16_t proxy_port = 0;
    int index = 1;
    while (index < argc && strcmp(argv[index], "--") != 0) {
        if (strcmp(argv[index], "--proxy-socket") == 0 && index + 1 < argc) {
            socket_path = argv[index + 1];
            index += 2;
            continue;
        }
        if (strcmp(argv[index], "--proxy-port") == 0 && index + 1 < argc) {
            long parsed = strtol(argv[index + 1], NULL, 10);
            if (parsed < 1 || parsed > 65535) {
                fprintf(stderr, "coda linux sandbox: invalid proxy port\n");
                return 126;
            }
            proxy_port = (uint16_t)parsed;
            index += 2;
            continue;
        }
        fprintf(stderr, "coda linux sandbox: unknown helper option: %s\n", argv[index]);
        return 126;
    }
    if (index >= argc || strcmp(argv[index], "--") != 0 || index + 1 >= argc) {
        fprintf(stderr, "coda linux sandbox: expected -- followed by a command\n");
        return 126;
    }
    if ((socket_path == NULL) != (proxy_port == 0)) {
        fprintf(stderr, "coda linux sandbox: proxy socket and port must be supplied together\n");
        return 126;
    }
    if (socket_path != NULL) {
        bring_loopback_up();
        pid_t bridge = fork();
        if (bridge < 0) fail("could not fork managed proxy bridge");
        if (bridge == 0) run_proxy_bridge(socket_path, proxy_port);
    }
    drop_capabilities();
    install_seccomp();
    execvp(argv[index + 1], &argv[index + 1]);
    fail("could not execute sandbox command");
    return 126;
}
