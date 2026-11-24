@echo off
chcp 65001 >nul
cd /d "%~dp0electron"
if not exist node_modules (
  echo 第一次启动，正在安装依赖（约 1-2 分钟）...
  call npm install --registry=https://registry.npmmirror.com
)
call npm start
