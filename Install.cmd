@echo off
setlocal
rem Windows setup wizard; only invokes bundled, auditable PowerShell source.
set "SETUP=%~dp0scripts\setup-wizard.ps1"
if not exist "%SETUP%" (
  echo The installer files are incomplete. Extract the entire ZIP first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%SETUP%"
if errorlevel 1 (
  echo.
  echo Setup could not start. See the error above or README.md.
  pause
  exit /b 1
)
endlocal