/**
 * 打包配置覆盖：在不具备管理员权限 / 开发者模式的环境下打包
 *
 * 背景：electron-builder 在 Windows 上会下载 winCodeSign 工具链，该 7z 包内含
 *       macOS 用的符号链接（darwin/*.dylib），非管理员账户无法创建符号链接，
 *       解压会失败，进而中断打包。
 * 作用：关闭"重写 exe 图标与版本信息"这一步（win.signAndEditExecutable = false），
 *       从而不再依赖 winCodeSign。代价：生成的 exe 使用 Electron 默认图标/版本信息。
 *
 * 正式分发建议：在开启 Windows 开发者模式（或管理员）的机器上执行
 *   npm run dist
 * 即可得到带图标与版本信息的完整产物。
 *
 * 用法： npx electron-builder --win nsis portable --config electron-builder.nosign.config.js
 */
const base = require('./electron-builder.config.js');

module.exports = {
  ...base,
  win: {
    ...base.win,
    signAndEditExecutable: false,
    // 关闭签名相关步骤（本项目未配置证书，避免再次触发工具链下载）
    sign: null,
    verifyUpdateCodeSignature: false
  },
  afterPack: undefined
};
