@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"
set "PYTHON_EXE=python"
if exist "D:\Anaconda\python.exe" set "PYTHON_EXE=D:\Anaconda\python.exe"
set "NPM_EXE=npm.cmd"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_EXE=%ProgramFiles%\nodejs\npm.cmd"
if exist "%AppData%\npm\npm.cmd" set "NPM_EXE=%AppData%\npm\npm.cmd"

echo [0/3] Clean occupied ports if needed...
for %%P in (8000 5173) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    if not "%%I"=="0" (
      echo Killing PID %%I on port %%P...
      taskkill /PID %%I /F >nul 2>nul
    )
  )
)

echo [1/3] Check backend dependencies...
echo Skip upgrading musicdl; using pinned version in requirements.txt

"%PYTHON_EXE%" -m pip show fastapi >nul 2>nul
if errorlevel 1 (
    echo Installing backend requirements...
    "%PYTHON_EXE%" -m pip install -r "backend\requirements.txt"
)

echo [2/3] Starting backend API...
start "Music API" /D "%ROOT%" cmd /k ""%PYTHON_EXE%" -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000"

echo [3/3] Starting frontend...
if not exist "%ROOT%frontend\package.json" (
    echo Frontend folder not found: "%ROOT%frontend"
    pause
    exit /b 1
)
start "Music Frontend" /D "%ROOT%frontend" cmd /k ""%NPM_EXE%" run dev"

echo.
echo Started:
echo - Backend: http://127.0.0.1:8000
echo - Frontend: check terminal output, usually http://127.0.0.1:5173
echo.
pause
