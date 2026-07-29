# coda pixel logo

`coda-pixel-logo-reference.png` 是全屏 TUI Logo 的设计参考图。运行时不会读取 PNG；
`src/cli/tui.ts` 中的 `PIXEL_LOGO` 使用 Unicode block characters 复刻其狐狸耳朵、
机器人面罩与两只方形眼睛，因而不依赖终端图片协议。

生成方式：Codex 内置 ImageGen 的 text-to-image 模式，2026-07-29。生成接口未返回
可验证的底层模型标识；按用户要求不强制限定为 `gpt-image-2`。

最终提示词：

> Use case: logo-brand. Asset type: visual reference for recreating a terminal TUI
> logo with Unicode block characters. Create an original tiny pixel-art mascot logo
> for a terminal coding agent named coda: a friendly compact robot shaped like a code
> cursor, with a subtle fox-like silhouette and two square eyes. Plain warm off-white
> background; authentic hand-placed 16-bit pixel art aligned to a coarse 16 by 12 pixel
> grid; flat colors, no antialiasing, no gradients. One centered front-facing mascot
> with a strong readable silhouette and generous empty margin. Coral red main color,
> dark ink facial details, warm cream highlights; maximum three colors plus background.
> No text, letters, wordmark, mockup, 3D, shadow, watermark, or trademarked imagery.
> It must remain recognizable when recreated at roughly 12 terminal columns by 6 rows,
> with crisp hard pixel edges only.
