@echo off
chcp 65001 >nul
title KHOI DONG HE THONG QUAN CA PHE CONG KHAI
echo ========================================================
echo   HỆ THỐNG POS & KDS QUÁN CÀ PHÊ - CHẠY CÔNG KHAI
echo ========================================================
cd /d "%~dp0quancaffe"
start "POS Server (Backend & UI)" cmd /c "npx.cmd tsx server/src/server.ts"
timeout /t 3 >nul
start "Cloudflare Tunnel (Public URL)" cmd /c "cloudflared.exe tunnel --url http://localhost:3001"
echo.
echo Đã khởi động xong Server và Cloudflare Tunnel!
echo Vui lòng xem cửa sổ Cloudflare Tunnel để lấy đường link https://...trycloudflare.com
echo ========================================================
pause
