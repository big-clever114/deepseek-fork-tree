@echo off
setlocal
set "EXT=%~dp0"
set "EXT=%EXT:~0,-1%"
if not exist "%EXT%\manifest.json" goto broken
start "" msedge.exe "edge://extensions"
start "" explorer.exe /select,"%EXT%"
start "" "%EXT%\install-guide.html"
exit /b 0
:broken
echo(
echo  [ERROR] manifest.json not found in:
echo          %EXT%
echo(
pause >nul
exit /b 1
