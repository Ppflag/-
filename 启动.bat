@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo [閿欒] 娌℃壘鍒?Node.js銆?  echo 璇峰厛瀹夎 Node 18 鎴栨洿楂樼増鏈細https://nodejs.org/
  echo 瀹夎鍚庡啀鍙屽嚮鏈枃浠躲€?  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [鎻愮ず] 杩樻病鏈?.env锛孉I 鎷嶇収璇嗗埆浼氭彁绀?鏈厤缃瘑閽?銆?  echo        闇€瑕佽瘑鍒椂锛氭妸 .env.example 澶嶅埗鎴?.env锛屽～鍏?DEEPSEEK_API_KEY銆?  echo.
)

echo 姝ｅ湪鍚姩锛岃绋嶇瓑 1-2 绉掆€︹€?echo 娴忚鍣ㄦ墦寮€锛歨ttp://localhost:3000
echo 鍏抽棴杩欎釜绐楀彛鍗冲仠姝㈡湇鍔°€?echo.
"%NODE_EXE%" server.js
pause
