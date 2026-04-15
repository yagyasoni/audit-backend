@echo off
taskkill /F /IM nginx.exe
cd C:\nginx-1.29.6\nginx-1.29.6
start nginx.exe