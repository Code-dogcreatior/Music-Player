"""桌面壳：后台跑 uvicorn，前台用 PySide6 + QWebEngineView 装载现有 SPA。

设计要点：
- uvicorn 必须放后台线程，主线程让给 Qt（PySide6 GUI 必须在主线程）。
- uvicorn.Config(install_signal_handlers=False) 因为子线程不能注册 SIGINT。
- 关窗 -> server.should_exit = True 让 uvicorn 优雅退出，进程随 Qt 退出而终止。
- 端口默认 8000，被占用则让 OS 选一个空闲端口，避免"上次实例没退干净"导致启动失败。
"""

from __future__ import annotations

import io
import os
import socket
import sys
import threading
import time

# console=False 的 PyInstaller 窗口程序里 sys.stdout/stderr 为 None，
# uvicorn 的 ColourizedFormatter 会调 stdout.isatty() 直接炸；先兜底成可写空流。
if sys.stdout is None:
    sys.stdout = io.StringIO()
if sys.stderr is None:
    sys.stderr = io.StringIO()

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(CURRENT_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import uvicorn  # noqa: E402
from PySide6.QtCore import QTimer, QUrl  # noqa: E402
from PySide6.QtGui import QIcon  # noqa: E402
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402
from PySide6.QtWidgets import QApplication, QMainWindow  # noqa: E402

from backend.app import app  # noqa: E402
from backend.update_service import update_restart_requested  # noqa: E402


HOST = "127.0.0.1"
PREFERRED_PORT = int(os.getenv("MUSIC_SERVER_PORT", "8000"))
WINDOW_TITLE = "音乐播放器"
WINDOW_WIDTH = 1280
WINDOW_HEIGHT = 800
SERVER_READY_TIMEOUT = 20.0


def get_resource_dir() -> str:
    """冻结后用 _MEIPASS（spec 把 assets 打进去）；开发时回项目根。"""
    return getattr(sys, "_MEIPASS", PROJECT_ROOT)


def get_app_icon_path() -> str:
    base = get_resource_dir()
    for name in ("icon.ico", "icon.png"):
        candidate = os.path.join(base, "assets", name)
        if os.path.isfile(candidate):
            return candidate
    return ""


def pick_port() -> int:
    """优先 PREFERRED_PORT；被占就让 OS 自动分配，避免硬性失败。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((HOST, PREFERRED_PORT))
            return PREFERRED_PORT
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


def wait_until_serving(port: int, timeout: float = SERVER_READY_TIMEOUT) -> bool:
    """轮询 TCP 直到 uvicorn 监听就绪，最多等 timeout 秒。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.3)
            if sock.connect_ex((HOST, port)) == 0:
                return True
        time.sleep(0.1)
    return False


class MainWindow(QMainWindow):
    def __init__(self, server: uvicorn.Server, url: str, icon: QIcon | None = None) -> None:
        super().__init__()
        self._server = server
        self.setWindowTitle(WINDOW_TITLE)
        self.resize(WINDOW_WIDTH, WINDOW_HEIGHT)
        if icon is not None and not icon.isNull():
            self.setWindowIcon(icon)
        self.view = QWebEngineView(self)
        self.view.load(QUrl(url))
        self.setCentralWidget(self.view)

    def closeEvent(self, event) -> None:  # noqa: N802 (Qt 接口名)
        # 关窗即停后端：uvicorn 主循环检测到 should_exit 后会跳出 serve()
        self._server.should_exit = True
        super().closeEvent(event)


def _run_uvicorn(server: uvicorn.Server) -> None:
    try:
        server.run()
    except SystemExit:
        # uvicorn 在某些路径下会 sys.exit()，子线程吞掉即可
        pass


def main() -> int:
    port = pick_port()

    # log_config=None：彻底关掉 uvicorn 默认彩色日志配置（GUI 进程没 stdout，配上反而崩）
    config = uvicorn.Config(app, host=HOST, port=port, log_level="warning", log_config=None)
    server = uvicorn.Server(config)
    # 子线程不能注册信号处理器；GUI 进程也不需要 uvicorn 接管 SIGINT
    server.config.install_signal_handlers = False

    backend_thread = threading.Thread(target=_run_uvicorn, args=(server,), daemon=True)
    backend_thread.start()

    if not wait_until_serving(port):
        sys.stderr.write(f"后端在 {SERVER_READY_TIMEOUT}s 内未就绪，启动失败\n")
        return 1

    qt_app = QApplication(sys.argv)
    icon_path = get_app_icon_path()
    icon = QIcon(icon_path) if icon_path else QIcon()
    if not icon.isNull():
        qt_app.setWindowIcon(icon)
    window = MainWindow(server, f"http://{HOST}:{port}/", icon=icon)
    window.show()
    update_timer = QTimer()
    update_timer.setInterval(250)
    update_timer.timeout.connect(lambda: window.close() if update_restart_requested.is_set() else None)
    update_timer.start()
    exit_code = qt_app.exec()
    server.should_exit = True
    backend_thread.join(timeout=5)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
