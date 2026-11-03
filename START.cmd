@echo off
cd /d "%~dp0"
set PORT=3187
echo Open http://127.0.0.1:3187 in your browser
node server.mjs
pause
