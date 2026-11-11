@echo off
title NBA Props Dash - updating data
cd /d "%~dp0"

set PY=python
where py >nul 2>nul && set PY=py -3

echo.
echo [1/4] Syncing with GitHub...
git pull --rebase --autostash
if errorlevel 1 goto :fail

echo.
echo [2/4] Checking Python packages...
%PY% -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :fail

echo.
echo [3/4] Pulling stats from NBA.com (takes a few minutes)...
%PY% scripts\fetch_data.py
if errorlevel 1 goto :fail

echo.
echo [4/4] Uploading to GitHub...
git add docs/data
git commit -q -m "Update NBA data"
git push
if errorlevel 1 goto :fail

echo.
echo Done! The site updates in 1-2 minutes:
echo https://elin1705.github.io/nbadash/
echo.
pause
exit /b 0

:fail
echo.
echo Something went wrong - scroll up for the error, or screenshot this window.
pause
exit /b 1
