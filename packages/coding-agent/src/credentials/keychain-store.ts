import type { SystemCredentialClient } from "./system-credential-store.ts";
import { CODA_CREDENTIAL_SERVICE, SystemCredentialStore } from "./system-credential-store.ts";

export const CODA_KEYCHAIN_SERVICE = CODA_CREDENTIAL_SERVICE;

export interface KeychainClient extends SystemCredentialClient {}

export class KeychainCredentialStore extends SystemCredentialStore {}
