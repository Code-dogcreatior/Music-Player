@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "PYTHON_EXE=python"
if exist "D:\Anaconda\python.exe" set "PYTHON_EXE=D:\Anaconda\python.exe"

"%PYTHON_EXE%" "%ROOT%build.py" %*
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

pause
exit /b 0
