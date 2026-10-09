@echo off
chcp 65001 >nul
title NaturalVoice Studio Server (Port 3177)
color 0A

echo ========================================================
echo             NaturalVoice Studio - Server Runner
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/3] Kiem tra Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [LOI] Khong tim thay Node.js tren may tinh!
    echo Vui long cai dat Node.js tai: https://nodejs.org/
    pause
    exit /b 1
)

echo [2/3] Tat cac tien trinh cu dang chay cong 3177 (neu co)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3177" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)

echo [3/3] Dang khoi dong NaturalVoice Studio...
echo.
echo ========================================================
echo  Website: http://127.0.0.1:3177
echo  Nhan Ctrl + C de dung server bat cu luc nao.
echo ========================================================
echo.

start "" "http://127.0.0.1:3177"

node server.js

pause
