@echo off
setlocal
cd /d "%~dp0.."
title WestWorldV3 Prompt Sync

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm not found. Please install Node.js first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo node_modules not found. Run "npm install" in the project root first.
  pause
  exit /b 1
)

:menu
cls
echo ==========================================
echo   WestWorldV3 Prompt Sync
echo ==========================================
echo   Project: %CD%
echo   1. Preview changes (dry-run)
echo   2. Sync hashes/examples + governance check
echo   3. Sync + full checks (typecheck, unit tests, OpenSpec)
echo   0. Exit
echo.
set "choice="
set /p choice=Select [1/2/3/0]:
if "%choice%"=="1" goto dry
if "%choice%"=="2" goto sync
if "%choice%"=="3" goto full
if "%choice%"=="0" exit /b 0
goto menu

:dry
call npm run prompts:sync -- --dry-run
set "result=%errorlevel%"
goto done

:sync
call npm run prompts:sync
set "result=%errorlevel%"
goto done

:full
call npm run prompts:sync -- --full
set "result=%errorlevel%"
goto done

:done
echo.
if not "%result%"=="0" (
  echo Failed. See the output above.
) else (
  echo Done.
)
pause
endlocal
