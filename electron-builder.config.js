/**
 * electron-builder 打包配置
 * 产物：release/ 目录下的 NSIS 安装包 + portable 便携版（都是 .exe）
 *
 * ── 代码签名说明（评审 P3）──────────────────────────────────────────────
 * 本配置**不含代码签名**（`win` 段未设置 `certificateFile` / `certificatePassword`），
 * 因此产物是**未签名 exe**：Windows SmartScreen 会提示「未知发布者」，杀毒软件
 * 也常见误报（均为误判，非程序有害）。
 * **正式对外分发建议购买代码签名证书**（OV/EV），并在下方 `win` 段补充：
 *     certificateFile: 'path/to/cert.pfx',
 *     certificatePassword: process.env.CSC_KEY_PASSWORD,
 * （或改用 electron-builder 支持的云签名服务）。签名后即可消除「未知发布者」提示
 * 并显著降低误报率。当前不配置签名是**有意为之**：仓库不携带私钥，便于免密构建。
 * ─────────────────────────────────────────────────────────────────────
 */
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.sz333.unpack',
  productName: 'sz333 解压工具',
  copyright: 'Copyright © 2026 sz333',

  // 输出目录
  directories: {
    output: 'release',
    buildResources: 'build'
  },

  // 只打包运行期必需的文件（源码不随包分发）
  files: [
    'out/**/*',
    'package.json',
    '!**/*.map',
    '!**/{.eslintrc,.editorconfig,.gitignore,tsconfig*.json}',
    '!src/**',
    '!scripts/**',
    '!release/**'
  ],

  // 7-Zip 引擎：放在 asar 之外，保证能被 spawn 调用
  extraResources: [
    {
      from: 'resources/7z.exe',
      to: '7z.exe'
    },
    {
      from: 'resources/7z.dll',
      to: '7z.dll'
    }
  ],

  asar: true,
  compression: 'maximum',

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ],
    icon: 'build/icon.ico',
    artifactName: '${productName}-${version}-${arch}-${env.BUILD_KIND}.exe',
    // 可选：右键菜单与文件关联（默认关闭，开启会写入注册表）
    // fileAssociations: [
    //   { ext: ['zip', '7z', 'rar', 'tar', 'gz'], name: '压缩包', icon: 'build/icon.ico' }
    // ]
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'sz333 解压工具',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    // 卸载时**不无条件**删除用户级配置目录（%APPDATA%\sz333-unpack-desktop）。
    // 保留 settings/history/workflows 是**设计选择**（便于重装后继续使用）；
    // 是否删除改由卸载时的**询问**决定，见 build/installer.nsh 的 customUnInstall。
    deleteAppDataOnUninstall: false,
    // 卸载钩子（本宏只做两件安全的事；机制与实证详见 build/installer.nsh 文件头）：
    //   ⚠ 注意：安装目录内容的**递归删除**发生在上游模板 templates/nsis/uninstaller.nsh:169
    //     的 `RMDir /r $INSTDIR`，它在本宏(customUnInstall)之前**无条件**执行 → 连用户自放文件
    //     一并被删（既有行为，非本宏所为；故请勿把数据放进安装目录）。
    //   ① 删除**空**的安装目录本体（NSIS `RMDir` 不带 /r 仅删空目录；须先 `SetOutPath $TEMP`
    //      解开卸载器自身 CWD 对 $INSTDIR 的锁，否则只能清空、删不掉本体 → 残留空壳）。
    //   ② 询问是否删除配置与历史（默认按钮=否；静默 /S 卸载不弹窗 → 保留配置）。
    // 已核对路径：appdata 目录名与 src/main/engine.ts userDataDir() 一致（见 installer.nsh 注释）。
    include: 'build/installer.nsh'
  },

  portable: {
    artifactName: '${productName}-${version}-便携版.exe',
    requestExecutionLevel: 'user'
  },

  // 不生成 blockmap / 不自动发布
  publish: null,
  buildDependenciesFromSource: false,
  npmRebuild: false
};
