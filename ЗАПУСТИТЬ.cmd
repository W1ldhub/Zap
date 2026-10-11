@echo off
title Zap
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 goto ready

echo.
echo   Не найден Node.js.
echo   Установите его с сайта:  https://nodejs.org
echo   Скачайте версию LTS и установите с настройками по умолчанию.
echo.
pause
exit /b 1

:ready
if not exist "node_modules" (
  echo   Первый запуск: устанавливаю нужные программы, подождите...
  call npm install --no-audit --no-fund
)

echo.
echo   Запускаю Zap...
echo   Откройте в браузере:  http://localhost:3000
echo.
call npm start

echo.
echo   Сервер остановлен.
pause
