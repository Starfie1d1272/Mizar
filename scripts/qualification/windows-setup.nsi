Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
Var ControlledUpdate
Name "Mizar"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Mizar"
InstallDirRegKey HKCU "Software\Mizar" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mizar.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Mizar"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchInstalled
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE UpdateDirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShown
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  StrCpy $ControlledUpdate "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/MIZARUPDATE" $1
  IfErrors +2 0
  StrCpy $ControlledUpdate "1"
  Call CheckRunning
FunctionEnd
Function UpdateDirectoryPre
  StrCmp $ControlledUpdate "1" 0 done
  Abort
  done:
FunctionEnd
Function FinishShown
  StrCmp $ControlledUpdate "1" 0 done
  SendMessage $mui.FinishPage.Run ${BM_SETCHECK} ${BST_UNCHECKED} 0
  EnableWindow $mui.FinishPage.Run 0
  done:
FunctionEnd
Function LaunchInstalled
  StrCmp $ControlledUpdate "1" done
  Exec '"$INSTDIR\Mizar.exe"'
  done:
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

Section "Mizar（必选）" SecMain
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
