!macro customUnInstall
   !ifdef __UNINSTALL__
     SetShellVarContext current
     Delete "$LocalAppdata\MyUI\.settings.db"
     Delete "$LocalAppdata\MyUI\.contrib.db"
     SetShellVarContext lastused
   !endif
!macroend