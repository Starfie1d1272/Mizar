Unicode true
!include "MUI2.nsh"
ManifestDPIAware true
Name "Mizar"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Mizar"
InstallDirRegKey HKCU "Software\Mizar" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
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
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载 Mizar 程序和快捷方式。比赛资料、设置与日志将保留。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mizar.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Mizar"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_HEADER_TEXT "快捷方式"
!define MUI_PAGE_HEADER_SUBTEXT "选择是否创建桌面快捷方式。"
!define MUI_COMPONENTSPAGE_NODESC
!define MUI_COMPONENTSPAGE_TEXT_TOP "Mizar 主程序将自动安装。按需勾选桌面快捷方式，随后点击“安装”。"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  Call CheckRunning
FunctionEnd
Function CheckRunning
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name Mizar -ErrorAction SilentlyContinue) { exit 1 }"'
  Pop $0
  Pop $1
  StrCmp $0 "0" done
  MessageBox MB_OK|MB_ICONEXCLAMATION "请先正常退出 Mizar，恢复游戏设置后再安装。" /SD IDOK
  Abort
  done:
FunctionEnd

Section "-Mizar" SecMain
  SectionIn RO
  ; The previous uninstaller only removes its own recorded payload. User data is separate.
  IfFileExists "$INSTDIR\Uninstall.exe" 0 install
  ExecWait '"$INSTDIR\Uninstall.exe" /S _?=$INSTDIR' $0
  StrCmp $0 "0" install
  Abort "旧版本卸载未完成，请正常退出应用后重试。"
  install:
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  FileOpen $0 "$INSTDIR\installed.flag" w
  FileWrite $0 "Mizar per-user installation"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Mizar"
  CreateShortcut "$SMPROGRAMS\Mizar\Mizar.lnk" "$INSTDIR\Mizar.exe"
  CreateShortcut "$SMPROGRAMS\Mizar\卸载 Mizar.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Mizar" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "DisplayName" "Mizar"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "DisplayIcon" "$INSTDIR\Mizar.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "NoRepair" 1
SectionEnd
Section /o "桌面快捷方式" SecDesktop
  CreateShortcut "$DESKTOP\Mizar.lnk" "$INSTDIR\Mizar.exe"
SectionEnd

Function un.onInit
  SetShellVarContext current
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name Mizar -ErrorAction SilentlyContinue) { exit 1 }"'
  Pop $0
  Pop $1
  StrCmp $0 "0" done
  MessageBox MB_OK|MB_ICONEXCLAMATION "请先正常退出 Mizar，再卸载。用户资料将保留。" /SD IDOK
  SetErrorLevel 1
  Abort
  done:
FunctionEnd
Section "Uninstall"
  !include "${REMOVE_FILES}"
  Delete "$INSTDIR\installed.flag"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\Mizar.lnk"
  Delete "$SMPROGRAMS\Mizar\Mizar.lnk"
  Delete "$SMPROGRAMS\Mizar\卸载 Mizar.lnk"
  RMDir "$SMPROGRAMS\Mizar"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar"
  DeleteRegKey HKCU "Software\Mizar"
SectionEnd
