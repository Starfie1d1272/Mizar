Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"
ManifestDPIAware true
ManifestLongPathAware true
Var ExtractTarget
Name "Mizar"
BrandingText "Mizar"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Mizar"
InstallDirRegKey HKCU "Software\Mizar" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
; Keep native controls and keyboard/focus behavior. Art contains no user text.
!ifdef INSTALLER_ASSETS
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${INSTALLER_ASSETS}\wizard.bmp"
  !define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"
  !define MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_BITMAP "${INSTALLER_ASSETS}\header.bmp"
  !define MUI_HEADERIMAGE_BITMAP_STRETCH "FitControl"
!endif
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 Mizar"
!define MUI_WELCOMEPAGE_TEXT "让校园赛事，也有职业赛场的转播呈现。$\r$\n$\r$\nMizar 将安装到当前用户的目录。你可以更改安装位置，并选择是否创建桌面快捷方式。$\r$\n$\r$\n点击“下一步”开始。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。用户资料单独保存，升级与卸载时保留。"
!define MUI_FINISHPAGE_TITLE "Mizar 已安装"
!define MUI_FINISHPAGE_TEXT "现在可以开始准备你的比赛。$\r$\n$\r$\n点击“完成”关闭向导；勾选下方选项即可启动 Mizar。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mizar.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Mizar"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchInstalled
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_HEADER_TEXT "快捷方式"
!define MUI_PAGE_HEADER_SUBTEXT "选择是否创建桌面快捷方式。"
!define MUI_COMPONENTSPAGE_NODESC
!define MUI_COMPONENTSPAGE_TEXT_COMPLIST "可选项目："
!define MUI_COMPONENTSPAGE_TEXT_TOP "Mizar 主程序将自动安装。按需勾选桌面快捷方式，随后点击“安装”。"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9

Function .onInit
  SetShellVarContext current
  StrCpy $ExtractTarget ""
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/MIZAREXTRACT=" $ExtractTarget
  IfErrors +2
  SetSilent silent
FunctionEnd

Function LaunchInstalled
  Exec '"$INSTDIR\Mizar.exe"'
FunctionEnd

Section /o "桌面快捷方式" SecDesktop
SectionEnd

Section "-Mizar" SecMain
  SectionIn RO
  StrCmp $ExtractTarget "" normal_install
  SetOutPath "$ExtractTarget"
  File /r "${PAYLOAD}\*"
  IfErrors 0 +3
  SetErrorLevel 14
  Abort "解压安装载荷失败。"
  Return

normal_install:
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${PAYLOAD}\*"
  IfErrors 0 +3
  SetErrorLevel 14
  Abort "解压安装载荷失败，请检查磁盘空间后重试。"

  StrCpy $1 ""
  SectionGetFlags ${SecDesktop} $0
  IntOp $0 $0 & ${SF_SELECTED}
  StrCmp $0 "0" +2
  StrCpy $1 "--desktop-shortcut"

  SetOutPath "$TEMP"
  ExecWait '"$PLUGINSDIR\payload\mizar-applier.exe" install --payload-dir "$PLUGINSDIR\payload" --install-dir "$INSTDIR" --no-ui --no-launch $1 --result-file "$PLUGINSDIR\result.json"' $0
  StrCmp $0 "0" install_ok
  SetErrorLevel $0
  StrCmp $0 "10" 0 +2
  Abort "另一个 Mizar 安装或更新正在进行，请稍后重试。"
  StrCmp $0 "11" 0 +2
  Abort "请先正常退出正在运行的 Mizar，然后重试安装。"
  StrCmp $0 "15" 0 +2
  Abort "安装已取消。"
  Abort "安装未完成（错误码：$0）。请保留现场并查看 %LOCALAPPDATA%\Mizar\logs 中的日志。"
install_ok:
SectionEnd
