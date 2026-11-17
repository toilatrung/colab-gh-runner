@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto run

rem ---- Tim Python 3 ----
set "PYEXE="
rem 1) Python do uv quan ly (%APPDATA%\uv\python\cpython-3.*)
for /d %%D in ("%APPDATA%\uv\python\cpython-3*") do (
  if exist "%%D\python.exe" set "PYEXE=%%D\python.exe"
)
rem 2) python / python3 trong PATH (bo qua alias Microsoft Store)
if not defined PYEXE for %%C in (python.exe python3.exe) do (
  if not defined PYEXE for /f "delims=" %%P in ('where %%C 2^>nul ^| findstr /v /i "WindowsApps"') do (
    if not defined PYEXE set "PYEXE=%%P"
  )
)
rem 3) py launcher
if not defined PYEXE (
  where py >nul 2>nul && for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%P"
)

if not defined PYEXE (
  where uv >nul 2>nul && (
    echo Khong thay Python, dung uv de tao venv ...
    uv venv .venv --python 3.12 || goto nopy
    goto deps
  )
  goto nopy
)
echo Dung Python: !PYEXE!
"!PYEXE!" -m venv .venv || (echo [LOI] Khong tao duoc venv & exit /b 1)

:deps
".venv\Scripts\python.exe" -m ensurepip -q >nul 2>nul
".venv\Scripts\python.exe" -m pip install -q --upgrade pip
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt && (
  ".venv\Scripts\python.exe" -m playwright install chromium
) || (
  echo [CANH BAO] Khong cai duoc Playwright - webapp van chay o che do "browser".
)

:run
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" server.py %*
exit /b %errorlevel%

:nopy
echo.
echo [LOI] Khong tim thay Python 3.
echo   Cai: winget install -e --id Python.Python.3.12   ^(hoac: uv python install 3.12^)
echo   Mo lai PowerShell roi chay lai .\start.bat
exit /b 1
