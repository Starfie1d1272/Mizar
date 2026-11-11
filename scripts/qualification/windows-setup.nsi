Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
ManifestDPIAware true
Var ControlledUpdate
Var InstallationOwner
Var ExternalOwner
Var UpdateWriter
Var HandoffStateRoot
Var HandoffParentReceipt
Var HandoffProcessId
Var HandoffBootstrapOwner
Var HandoffLease
Var HandoffPowerShell
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
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载 Mizar 程序和快捷方式。比赛资料、设置与日志将保留。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mizar.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Mizar"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchInstalled
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE UpdateDirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_HEADER_TEXT "快捷方式"
!define MUI_PAGE_HEADER_SUBTEXT "选择是否创建桌面快捷方式。"
!define MUI_COMPONENTSPAGE_NODESC
!define MUI_COMPONENTSPAGE_TEXT_COMPLIST "可选项目："
!define MUI_COMPONENTSPAGE_TEXT_TOP "Mizar 主程序将自动安装。按需勾选桌面快捷方式，随后点击“安装”。"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShown
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9

!macro AcquireUpdateWriter
  ; Reuse the updater's one writer. Controlled parent/child extraction never
  ; reacquires its parent's mutex; independent Setup/uninstall holds it to exit.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\MizarUpdateWriter") p.r3'
  StrCpy $UpdateWriter $3
  StrCmp $3 "0" writer_blocked
  System::Call 'kernel32::WaitForSingleObject(p r3, i 0) i.r4'
  StrCmp $4 "0" writer_acquired
  StrCmp $4 "128" writer_acquired
  System::Call 'kernel32::CloseHandle(p r3)'
  writer_blocked:
  SetErrorLevel 1
  Abort "安装或恢复正在进行，请等待当前操作完成后重试。"
  writer_acquired:
!macroend

Function .onInit
  SetShellVarContext current
  StrCpy $HandoffPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
  StrCpy $HandoffPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $UpdateWriter "0"
  StrCpy $ControlledUpdate "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/MIZARLEASE=" $HandoffLease
  ReadRegStr $HandoffStateRoot HKCU "Software\Mizar" "StateRoot"
  ReadEnvStr $1 "MIZAR_STATE_ROOT"
  StrCmp $1 "" +2
  StrCpy $HandoffStateRoot $1
  ClearErrors
  ${GetOptions} $0 "/MIZARSTATE=" $1
  IfErrors +2
  StrCpy $HandoffStateRoot $1
  StrCmp $HandoffStateRoot "" 0 +2
  StrCpy $HandoffStateRoot "$LOCALAPPDATA\Mizar"
  ClearErrors
  ${GetOptions} $0 "/MIZARUPDATE" $1
  IfErrors +2 0
  StrCpy $ControlledUpdate "1"
  StrCpy $ExternalOwner "0"
  ClearErrors
  ${GetOptions} $0 "/MIZAROWNER=" $InstallationOwner
  IfErrors new_identity
  StrCmp $ControlledUpdate "1" 0 new_identity
  StrLen $1 $InstallationOwner
  StrCmp $1 "40" update_identity
  StrCmp $1 "42" 0 identity_failed
  StrCpy $1 $InstallationOwner 10
  StrCmp $1 "bootstrap-" 0 identity_failed
  StrCpy $5 10
  Goto validate_identity
  update_identity:
  StrCpy $1 $InstallationOwner 8
  StrCmp $1 "install-" 0 identity_failed
  StrCpy $5 8
  validate_identity:
  StrCpy $2 $InstallationOwner 1 $5
  StrCmp $2 "" controlled_identity
  StrCpy $3 0
  validate_character:
  StrCpy $4 "0123456789abcdef" 1 $3
  StrCmp $4 "" identity_failed
  StrCmp $2 $4 valid_character
  IntOp $3 $3 + 1
  Goto validate_character
  valid_character:
  IntOp $5 $5 + 1
  Goto validate_identity
  controlled_identity:
  StrCpy $ExternalOwner "1"
  Goto identity_ready
  new_identity:
  System::Call 'ole32::CoCreateGuid(g .r1) i.r2'
  StrCmp $2 "0" 0 identity_failed
  StrCpy $InstallationOwner $1
  Goto identity_ready
  identity_failed:
  SetErrorLevel 1
  Abort "无法创建本次安装身份，请重试。"
  identity_ready:
  StrCmp $ControlledUpdate "1" 0 acquire_writer
  ; Preserve the existing /MIZARUPDATE contract for older callers. They cannot
  ; prove a new instance owner and retain their previous concurrency boundary.
  StrCmp $ExternalOwner "1" 0 writer_ready
  StrCpy $1 $InstallationOwner 8
  ; Current update parents own the writer; fresh bootstrap owns only a file lease.
  StrCmp $1 "install-" writer_ready
  acquire_writer:
  !insertmacro AcquireUpdateWriter
  writer_ready:
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

Section "-Mizar" SecMain
  SectionIn RO
  ; The directory page has now selected the real target. No marker or payload
  ; is changed until all known old execution paths have been safely retired.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=update-handoff.ps1 "${PAYLOAD}\resources\scripts\update-install.ps1"
  ; Do not let the native NSIS System.dll shadow the .NET compiler reference.
  SetOutPath "$TEMP"
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $HandoffProcessId $0
  StrCmp $UpdateWriter "0" 0 handoff_writer_ready
  nsExec::ExecToStack '"$HandoffPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-handoff.ps1" -Mode Handoff -HandoffTarget "$INSTDIR" -HandoffState "$HandoffStateRoot" -CallerProcessId $HandoffProcessId -ProbeWriter -NoStatusWindow'
  Pop $0
  Pop $1
  StrCmp $0 "0" handoff_writer_ready
  StrCmp $0 "10" 0 handoff_failed
  !insertmacro AcquireUpdateWriter
  handoff_writer_ready:
  StrCpy $HandoffBootstrapOwner ""
  StrCpy $1 $InstallationOwner 10
  StrCmp $1 "bootstrap-" 0 +2
  StrCpy $HandoffBootstrapOwner $InstallationOwner
  StrCpy $2 ""
  StrCmp $HandoffLease "" +2
  StrCpy $2 ' -BootstrapLease $HandoffLease'
  StrCmp $HandoffBootstrapOwner "" +2
  StrCpy $2 '$2 -ExpectedBootstrap "$HandoffBootstrapOwner"'
  nsExec::ExecToStack '"$HandoffPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-handoff.ps1" -Mode Handoff -HandoffTarget "$INSTDIR" -HandoffState "$HandoffStateRoot" -CallerProcessId $HandoffProcessId -ReceiptPath "$PLUGINSDIR\handoff.json" -InstallationOwner "$InstallationOwner"$2 -NoStatusWindow'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 handoff_failed
  StrCpy $HandoffStateRoot $1
  Goto handoff_ready
  handoff_failed:
  DetailPrint "$1"
  SetErrorLevel 1
  Abort "旧安装或恢复责任尚未交接。请关闭旧更新窗口和轻量安装器，保留恢复资料后重试完整安装包；不要运行旧恢复脚本覆盖当前程序。"
  handoff_ready:
  ; Each install claims its own instance before any previous payload is removed.
  ; An interrupted later Setup must retire an old updater's directory marker too.
  CreateDirectory "$INSTDIR"
  StrCmp $ExternalOwner "1" 0 publish_instance_owner
  IfFileExists "$INSTDIR\.mizar-update-owner" 0 publish_instance_owner
  ; Never truncate the update parent's durable marker.
  ClearErrors
  FileOpen $0 "$INSTDIR\.mizar-update-owner" r
  IfErrors instance_write_failed
  FileRead $0 $1
  FileClose $0
  IfErrors instance_write_failed
  StrCmp $1 $InstallationOwner instance_owner_ready instance_write_failed
  publish_instance_owner:
  ClearErrors
  IfFileExists "$INSTDIR\.mizar-update-owner.$InstallationOwner.tmp" instance_write_failed
  FileOpen $0 "$INSTDIR\.mizar-update-owner.$InstallationOwner.tmp" w
  IfErrors instance_write_failed
  FileWrite $0 "$InstallationOwner"
  System::Call 'kernel32::FlushFileBuffers(p r0) i.r1'
  FileClose $0
  StrCmp $1 "0" instance_write_failed
  IfErrors instance_write_failed
  System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.mizar-update-owner.$InstallationOwner.tmp", w "$INSTDIR\.mizar-update-owner", i 9) i.r1'
  StrCmp $1 "0" instance_write_failed
  instance_owner_ready:
  StrCmp $ExternalOwner "1" keep_bootstrap_owner
  IfFileExists "$INSTDIR\.mizar-bootstrap-owner" 0 keep_bootstrap_owner
  Delete "$INSTDIR\.mizar-bootstrap-owner"
  IfErrors instance_write_failed
  keep_bootstrap_owner:
  ; The previous uninstaller only removes its own recorded payload. User data is separate.
  IfFileExists "$INSTDIR\Uninstall.exe" 0 install
  ExecWait '"$INSTDIR\Uninstall.exe" /S /MIZARUPDATE /MIZARHANDOFF="$PLUGINSDIR\handoff.json" /MIZARSTATE="$HandoffStateRoot" _?=$INSTDIR' $0
  StrCmp $0 "0" install
  Abort "旧版本卸载未完成，请正常退出应用后重试。"
  install:
  SetOutPath "$INSTDIR"
  ClearErrors
  IfFileExists "$INSTDIR\installed.flag.$InstallationOwner.tmp" instance_write_failed
  FileOpen $0 "$INSTDIR\installed.flag.$InstallationOwner.tmp" w
  IfErrors instance_write_failed
  FileWrite $0 "mizar.install.v1:$InstallationOwner"
  System::Call 'kernel32::FlushFileBuffers(p r0) i.r1'
  FileClose $0
  IfErrors instance_write_failed
  StrCmp $1 "0" instance_write_failed
  System::Call 'kernel32::MoveFileExW(w "$INSTDIR\installed.flag.$InstallationOwner.tmp", w "$INSTDIR\installed.flag", i 9) i.r1'
  StrCmp $1 "0" instance_write_failed
  Goto instance_ready
  instance_write_failed:
  SetErrorLevel 1
  Abort "本次安装身份未能保存，安装已停止。请保留现场并检查目录权限。"
  instance_ready:
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Mizar"
  CreateShortcut "$SMPROGRAMS\Mizar\Mizar.lnk" "$INSTDIR\Mizar.exe"
  CreateShortcut "$SMPROGRAMS\Mizar\卸载 Mizar.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Mizar" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Mizar" "StateRoot" "$HandoffStateRoot"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "DisplayName" "Mizar"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "DisplayIcon" "$INSTDIR\Mizar.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar" "NoRepair" 1
  StrCmp $ExternalOwner "1" keep_update_owner
  ClearErrors
  Delete "$INSTDIR\.mizar-update-owner"
  IfErrors instance_write_failed
  keep_update_owner:
SectionEnd
Section /o "桌面快捷方式" SecDesktop
  CreateShortcut "$DESKTOP\Mizar.lnk" "$INSTDIR\Mizar.exe"
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $HandoffPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
  StrCpy $HandoffPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $UpdateWriter "0"
  ReadRegStr $HandoffStateRoot HKCU "Software\Mizar" "StateRoot"
  ReadEnvStr $1 "MIZAR_STATE_ROOT"
  StrCmp $1 "" +2
  StrCpy $HandoffStateRoot $1
  StrCmp $HandoffStateRoot "" 0 +2
  StrCpy $HandoffStateRoot "$LOCALAPPDATA\Mizar"
  StrCpy $ControlledUpdate "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/MIZARLEASE=" $HandoffLease
  ClearErrors
  ${GetOptions} $0 "/MIZARSTATE=" $1
  IfErrors +2
  StrCpy $HandoffStateRoot $1
  ClearErrors
  ${GetOptions} $0 "/MIZARHANDOFF=" $HandoffParentReceipt
  ClearErrors
  ${GetOptions} $0 "/MIZAROWNER=" $HandoffBootstrapOwner
  ClearErrors
  ${GetOptions} $0 "/MIZARUPDATE" $1
  IfErrors +2 0
  StrCpy $ControlledUpdate "1"
  ; Only a receipt tied to the actual Setup parent may borrow its writer.
  StrCmp $HandoffParentReceipt "" 0 writer_ready
  !insertmacro AcquireUpdateWriter
  writer_ready:
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
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=update-handoff.ps1 "${PAYLOAD}\resources\scripts\update-install.ps1"
  ; Do not let the native NSIS System.dll shadow the .NET compiler reference.
  SetOutPath "$TEMP"
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $HandoffProcessId $0
  StrCpy $2 ""
  StrCmp $HandoffLease "" +2
  StrCpy $2 ' -BootstrapLease $HandoffLease'
  StrCmp $HandoffParentReceipt "" +2
  StrCpy $2 '$2 -ParentReceiptPath "$HandoffParentReceipt"'
  StrCmp $HandoffBootstrapOwner "" +2
  StrCpy $2 '$2 -ExpectedBootstrap "$HandoffBootstrapOwner"'
  nsExec::ExecToStack '"$HandoffPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-handoff.ps1" -Mode Handoff -HandoffTarget "$INSTDIR" -HandoffState "$HandoffStateRoot" -CallerProcessId $HandoffProcessId$2 -NoStatusWindow'
  Pop $0
  Pop $1
  StrCmp $0 "0" uninstall_handoff_ready
  DetailPrint "$1"
  SetErrorLevel 1
  Abort "旧恢复责任尚未交接，卸载已停止。请关闭旧更新窗口和安装器，保留恢复资料后重试。"
  uninstall_handoff_ready:
  !include "${REMOVE_FILES}"
  StrCmp $ControlledUpdate "1" preserve_instance_owner
  Delete "$INSTDIR\.mizar-update-owner"
  preserve_instance_owner:
  Delete "$INSTDIR\.mizar-bootstrap-owner"
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
