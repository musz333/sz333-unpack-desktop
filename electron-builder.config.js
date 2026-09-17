/**
 * electron-builder 打包配置
 * 产物：release/ 目录下的 NSIS 安装包 + portable 便携版（都是 .exe）
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
    deleteAppDataOnUninstall: false
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
