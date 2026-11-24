#!/bin/bash
cd "$(dirname "$0")/client-desktop" || exit 1
if [ ! -d node_modules ]; then
  echo "第一次启动，正在安装依赖（约 1-2 分钟）..."
  npm install --registry=https://registry.npmmirror.com || { echo "安装失败，请检查网络后重试"; exit 1; }
fi
npm start -- --settings
