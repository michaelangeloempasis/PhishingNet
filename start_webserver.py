#!/usr/bin/env python3
"""
Simple HTTP Server for PhishingNet Website
Run this to serve your website locally or on your network
"""

import http.server
import socketserver
import os
import sys
from pathlib import Path

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent.absolute()
PORT = int(os.getenv('PORT', '8000'))
HOST = os.getenv('HOST', '0.0.0.0')  # 0.0.0.0 allows access from network

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add CORS headers to allow cross-origin requests
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        # Add SEO-friendly headers
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        super().end_headers()
    
    def log_message(self, format, *args):
        # Custom log format
        print(f"[{self.log_date_time_string()}] {format % args}")

def main():
    os.chdir(SCRIPT_DIR)
    
    print("=" * 60)
    print("PhishingNet Website Server")
    print("=" * 60)
    print(f"Server starting on http://{HOST}:{PORT}")
    print(f"Local access: http://localhost:{PORT}")
    print(f"Network access: http://<your-ip>:{PORT}")
    print("\nTo find your IP address:")
    print("  Windows: ipconfig | findstr IPv4")
    print("  Linux/Mac: ifconfig | grep inet")
    print("\nPress Ctrl+C to stop the server")
    print("=" * 60)
    print()
    
    try:
        with socketserver.TCPServer((HOST, PORT), MyHTTPRequestHandler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        if e.errno == 98 or e.errno == 10048:  # Address already in use
            print(f"ERROR: Port {PORT} is already in use!")
            print(f"Try a different port: PORT=8001 python start_webserver.py")
            sys.exit(1)
        else:
            raise
    except KeyboardInterrupt:
        print("\n\nServer stopped.")
        sys.exit(0)

if __name__ == '__main__':
    main()

