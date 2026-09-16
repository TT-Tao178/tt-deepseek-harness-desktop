@echo off
chcp 65001 >nul
setlocal
set T=%LOCALAPPDATA%\Temp\tt-selfcheck-mech
if exist "%T%" rd /s /q "%T%"
mkdir "%T%\target\dsh-pet-roxy" "%T%\target2\scoped-pkg" "%T%\nm\@scope"
echo CANARY-A>"%T%\target\dsh-pet-roxy\canary.txt"
echo CANARY-B>"%T%\target2\scoped-pkg\canary.txt"
mklink /J "%T%\nm\dsh-pet-roxy" "%T%\target\dsh-pet-roxy" >nul
mklink /J "%T%\nm\@scope\scoped-pkg" "%T%\target2\scoped-pkg" >nul
echo [setup] junction top-level + scoped created
if not exist "%T%\nm\dsh-pet-roxy\canary.txt" (echo [setup-ERR] top junction broken & exit /b 1)
if not exist "%T%\nm\@scope\scoped-pkg\canary.txt" (echo [setup-ERR] scoped junction broken & exit /b 1)

echo [test] run: rmdir /s /q on nm (contains junctions, like dsh-home\node_modules)
rmdir /s /q "%T%\nm"

echo [verify] nm exists? 
if exist "%T%\nm" (echo [ERR] nm still exists) else (echo [OK] nm removed)
echo [verify] canary A (top-level junction target):
if exist "%T%\target\dsh-pet-roxy\canary.txt" (echo [OK] CANARY-A SURVIVED - target intact) else (echo [FAIL] CANARY-A DELETED - rmdir followed junction!)
echo [verify] canary B (scoped junction target):
if exist "%T%\target2\scoped-pkg\canary.txt" (echo [OK] CANARY-B SURVIVED - target intact) else (echo [FAIL] CANARY-B DELETED - rmdir followed junction!)
echo [verify] target dir contents still listed:
dir /b "%T%\target\dsh-pet-roxy" 2>nul
dir /b "%T%\target2\scoped-pkg" 2>nul
endlocal
