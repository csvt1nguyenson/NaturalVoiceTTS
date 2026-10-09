@echo off
setlocal
cd /d "%~dp0native-slint"
start "NaturalVoice Desktop" "%~dp0native-slint\target\release\naturalvoice_desktop.exe"
endlocal
