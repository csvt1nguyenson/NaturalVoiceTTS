@echo off
setlocal
cd /d "%~dp0desktop-tauri"
if not exist "node_modules\.bin\tauri.cmd" (
    echo Khong tim thay Tauri CLI. Chay npm install trong desktop-tauri truoc.
    pause
    exit /b 1
)
call "node_modules\.bin\tauri.cmd" dev
if errorlevel 1 (
    echo.
    echo NaturalVoice desktop khoi dong that bai.
    pause
    exit /b 1
)
endlocal
