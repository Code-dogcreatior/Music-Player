from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import requests

from backend.app_version import APP_VERSION, GITHUB_REPOSITORY, WINDOWS_RELEASE_ASSET


GITHUB_API_VERSION = "2022-11-28"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
UPDATE_CACHE_SECONDS = 10 * 60
DOWNLOAD_CHUNK_SIZE = 1024 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
VERSION_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")


class UpdateError(RuntimeError):
    pass


def normalize_version(value: str) -> str:
    raw = (value or "").strip()
    match = VERSION_PATTERN.fullmatch(raw)
    if not match:
        raise UpdateError(f"无效版本号：{raw or '空'}")
    return ".".join(match.groups())


def is_newer_version(candidate: str, current: str) -> bool:
    candidate_parts = tuple(int(part) for part in normalize_version(candidate).split("."))
    current_parts = tuple(int(part) for part in normalize_version(current).split("."))
    return candidate_parts > current_parts


def _github_headers() -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": f"Music-Player/{APP_VERSION}",
    }


def _asset_sha256(asset: dict[str, Any]) -> str:
    digest = str(asset.get("digest") or "").strip()
    if digest.lower().startswith("sha256:"):
        digest = digest.split(":", 1)[1]
    return digest.lower() if SHA256_PATTERN.fullmatch(digest) else ""


def _no_release_response(current_version: str, message: str = "GitHub 暂无正式 Release") -> dict[str, Any]:
    return {
        "current_version": current_version,
        "latest_version": current_version,
        "update_available": False,
        "can_auto_update": False,
        "packaged": bool(getattr(sys, "frozen", False)),
        "release_url": f"https://github.com/{GITHUB_REPOSITORY}/releases",
        "release_notes": "",
        "published_at": "",
        "asset_name": "",
        "asset_size": 0,
        "message": message,
    }


class UpdateManager:
    def __init__(
        self,
        *,
        current_version: str = APP_VERSION,
        repository: str = GITHUB_REPOSITORY,
        asset_name: str = WINDOWS_RELEASE_ASSET,
        update_root: Path | None = None,
        packaged_override: bool | None = None,
    ) -> None:
        self.current_version = normalize_version(current_version)
        self.repository = repository
        self.asset_name = asset_name
        self.latest_release_url = f"https://api.github.com/repos/{repository}/releases/latest"
        local_app_data = os.getenv("LOCALAPPDATA") or tempfile.gettempdir()
        self.update_root = update_root or Path(local_app_data) / "MusicPlayer" / "updates"
        self.packaged_override = packaged_override
        self.lock = threading.RLock()
        self.cached_release: dict[str, Any] | None = None
        self.cached_at = 0.0
        self.download_thread: threading.Thread | None = None
        self.restart_requested = threading.Event()
        self.download_state: dict[str, Any] = self._idle_download_state()

    def _is_packaged_windows(self) -> bool:
        packaged = bool(getattr(sys, "frozen", False)) if self.packaged_override is None else self.packaged_override
        return packaged and sys.platform == "win32"

    def _idle_download_state(self) -> dict[str, Any]:
        return {
            "status": "idle",
            "percent": 0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "message": "",
            "error": "",
            "version": "",
            "ready_to_install": False,
        }

    def check(self, *, force: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        with self.lock:
            if not force and self.cached_release is not None and now - self.cached_at < UPDATE_CACHE_SECONDS:
                return dict(self.cached_release)

        try:
            response = requests.get(self.latest_release_url, headers=_github_headers(), timeout=(4, 12))
            if response.status_code == 404:
                result = _no_release_response(self.current_version)
            else:
                response.raise_for_status()
                result = self._parse_release(response.json())
        except requests.RequestException as exc:
            raise UpdateError(f"检查 GitHub 更新失败：{exc}") from exc
        except (TypeError, ValueError) as exc:
            raise UpdateError(f"GitHub Release 数据无效：{exc}") from exc

        with self.lock:
            self.cached_release = dict(result)
            self.cached_at = now
        return result

    def _parse_release(self, release: dict[str, Any]) -> dict[str, Any]:
        latest_version = normalize_version(str(release.get("tag_name") or ""))
        assets = [asset for asset in release.get("assets", []) if isinstance(asset, dict)]
        package_asset = next((asset for asset in assets if asset.get("name") == self.asset_name), None)
        checksum_asset = next((asset for asset in assets if asset.get("name") == f"{self.asset_name}.sha256"), None)
        digest = _asset_sha256(package_asset or {})
        update_available = is_newer_version(latest_version, self.current_version)
        can_auto_update = bool(
            update_available
            and self._is_packaged_windows()
            and package_asset
            and (digest or checksum_asset)
        )
        return {
            "current_version": self.current_version,
            "latest_version": latest_version,
            "update_available": update_available,
            "can_auto_update": can_auto_update,
            "packaged": self._is_packaged_windows(),
            "release_url": str(release.get("html_url") or f"https://github.com/{self.repository}/releases"),
            "release_notes": str(release.get("body") or "")[:6000],
            "published_at": str(release.get("published_at") or ""),
            "asset_name": str((package_asset or {}).get("name") or ""),
            "asset_size": int((package_asset or {}).get("size") or 0),
            "asset_url": str((package_asset or {}).get("browser_download_url") or ""),
            "asset_sha256": digest,
            "checksum_url": str((checksum_asset or {}).get("browser_download_url") or ""),
            "message": "发现新版本" if update_available else "当前已经是最新版本",
        }

    def public_check(self, *, force: bool = False) -> dict[str, Any]:
        result = self.check(force=force)
        return {key: value for key, value in result.items() if key not in {"asset_url", "asset_sha256", "checksum_url"}}

    def start_download(self) -> dict[str, Any]:
        release = self.check(force=True)
        if not release.get("update_available"):
            raise UpdateError("当前已经是最新版本")
        if not release.get("can_auto_update"):
            if not self._is_packaged_windows():
                raise UpdateError("自动安装只在 Windows 打包版中可用")
            raise UpdateError("Release 缺少 Windows 更新包或 SHA-256 摘要")

        with self.lock:
            if self.download_thread and self.download_thread.is_alive():
                return dict(self.download_state)
            version = str(release["latest_version"])
            self.download_state = {
                **self._idle_download_state(),
                "status": "downloading",
                "message": f"正在下载 v{version}",
                "version": version,
                "total_bytes": int(release.get("asset_size") or 0),
            }
            self.download_thread = threading.Thread(
                target=self._download_update,
                args=(dict(release),),
                daemon=True,
                name="music-player-update-download",
            )
            self.download_thread.start()
            return dict(self.download_state)

    def status(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.download_state)

    def _set_download_state(self, **changes: Any) -> None:
        with self.lock:
            self.download_state.update(changes)

    def _expected_sha256(self, release: dict[str, Any]) -> str:
        digest = str(release.get("asset_sha256") or "").lower()
        if SHA256_PATTERN.fullmatch(digest):
            return digest
        checksum_url = str(release.get("checksum_url") or "")
        if not checksum_url:
            raise UpdateError("Release 没有可用的 SHA-256 摘要")
        response = requests.get(checksum_url, headers=_github_headers(), timeout=(4, 15))
        response.raise_for_status()
        token = (response.text or "").strip().split()[0].lower()
        if not SHA256_PATTERN.fullmatch(token):
            raise UpdateError("Release SHA-256 文件格式无效")
        return token

    def _download_update(self, release: dict[str, Any]) -> None:
        version = str(release["latest_version"])
        version_dir = self.update_root / f"v{version}"
        archive_path = version_dir / self.asset_name
        partial_path = archive_path.with_suffix(f"{archive_path.suffix}.part")
        try:
            if version_dir.exists():
                shutil.rmtree(version_dir)
            version_dir.mkdir(parents=True, exist_ok=True)
            total_bytes = int(release.get("asset_size") or 0)
            required_free = max(2 * 1024 * 1024 * 1024, total_bytes * 3)
            if shutil.disk_usage(version_dir).free < required_free:
                raise UpdateError("磁盘空间不足，至少需要约 2 GB 可用空间")

            digest = hashlib.sha256()
            downloaded = 0
            with requests.get(
                str(release["asset_url"]),
                headers=_github_headers(),
                stream=True,
                timeout=(8, 120),
            ) as response:
                response.raise_for_status()
                if total_bytes <= 0:
                    total_bytes = int(response.headers.get("Content-Length") or 0)
                with partial_path.open("wb") as output:
                    for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                        if not chunk:
                            continue
                        output.write(chunk)
                        digest.update(chunk)
                        downloaded += len(chunk)
                        percent = int(downloaded * 100 / total_bytes) if total_bytes > 0 else 0
                        self._set_download_state(
                            downloaded_bytes=downloaded,
                            total_bytes=total_bytes,
                            percent=max(0, min(99, percent)),
                        )

            self._set_download_state(status="verifying", message="正在校验 SHA-256", percent=99)
            expected = self._expected_sha256(release)
            actual = digest.hexdigest().lower()
            if actual != expected:
                raise UpdateError("更新包 SHA-256 校验失败，已拒绝安装")
            partial_path.replace(archive_path)
            self._set_download_state(
                status="ready",
                percent=100,
                downloaded_bytes=downloaded,
                total_bytes=total_bytes or downloaded,
                message=f"v{version} 已下载并校验完成",
                error="",
                ready_to_install=True,
                archive_path=str(archive_path),
                sha256=actual,
            )
        except (OSError, requests.RequestException, UpdateError) as exc:
            try:
                partial_path.unlink(missing_ok=True)
            except OSError:
                pass
            self._set_download_state(
                status="failed",
                message="更新下载失败",
                error=str(exc),
                ready_to_install=False,
            )

    def request_install_and_restart(self) -> dict[str, Any]:
        if not self._is_packaged_windows():
            raise UpdateError("自动安装只在 Windows 打包版中可用")
        state = self.status()
        archive_path = Path(str(state.get("archive_path") or ""))
        if state.get("status") != "ready" or not archive_path.is_file():
            raise UpdateError("更新包尚未下载完成")
        script_path, config_path = self._prepare_windows_updater(archive_path)
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        try:
            subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-File",
                    str(script_path),
                    "-ConfigPath",
                    str(config_path),
                ],
                close_fds=True,
                creationflags=creation_flags,
            )
        except OSError as exc:
            raise UpdateError(f"无法启动更新器：{exc}") from exc
        self.restart_requested.set()
        self._set_download_state(status="installing", message="正在关闭旧版本并安装更新")
        return {"ok": True, "message": "程序即将关闭，更新完成后会自动重启"}

    def _prepare_windows_updater(self, archive_path: Path) -> tuple[Path, Path]:
        work_dir = archive_path.parent
        script_path = work_dir / "apply-update.ps1"
        config_path = work_dir / "update-config.json"
        config = {
            "parentPid": os.getpid(),
            "archivePath": str(archive_path),
            "installDir": str(Path(sys.executable).resolve().parent),
            "executableName": Path(sys.executable).name,
            "workDir": str(work_dir),
        }
        config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        script_path.write_text(WINDOWS_UPDATER_SCRIPT, encoding="utf-8-sig")
        return script_path, config_path


WINDOWS_UPDATER_SCRIPT = r'''param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = "Stop"
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$installDir = [string]$config.installDir
$archivePath = [string]$config.archivePath
$exeName = [string]$config.executableName
$workDir = [string]$config.workDir
$stagingDir = Join-Path $workDir "staging"
$newExe = Join-Path $installDir $exeName
$newInternal = Join-Path $installDir "_internal"
$backupExe = Join-Path $installDir ($exeName + ".update-backup")
$backupInternal = Join-Path $installDir "_internal.update-backup"

Wait-Process -Id ([int]$config.parentPid) -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force

$packageRoot = $stagingDir
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $exeName))) {
    $children = @(Get-ChildItem -LiteralPath $stagingDir -Directory)
    if ($children.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $children[0].FullName $exeName))) {
        $packageRoot = $children[0].FullName
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $exeName))) { throw "更新包缺少主程序" }
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot "_internal"))) { throw "更新包缺少 _internal" }

if (Test-Path -LiteralPath $backupExe) { Remove-Item -LiteralPath $backupExe -Force }
if (Test-Path -LiteralPath $backupInternal) { Remove-Item -LiteralPath $backupInternal -Recurse -Force }
if (Test-Path -LiteralPath $newExe) { Move-Item -LiteralPath $newExe -Destination $backupExe }
if (Test-Path -LiteralPath $newInternal) { Move-Item -LiteralPath $newInternal -Destination $backupInternal }

$launched = $null
try {
    Copy-Item -LiteralPath (Join-Path $packageRoot $exeName) -Destination $newExe -Force
    Copy-Item -LiteralPath (Join-Path $packageRoot "_internal") -Destination $newInternal -Recurse -Force
    Get-ChildItem -LiteralPath $packageRoot -Force | Where-Object { $_.Name -notin @($exeName, "_internal") } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $installDir $_.Name) -Recurse -Force
    }
    $launched = Start-Process -FilePath $newExe -WorkingDirectory $installDir -PassThru
    Start-Sleep -Seconds 8
    $launched.Refresh()
    if ($launched.HasExited) { throw "新版本启动后异常退出" }
    if (Test-Path -LiteralPath $backupExe) { Remove-Item -LiteralPath $backupExe -Force }
    if (Test-Path -LiteralPath $backupInternal) { Remove-Item -LiteralPath $backupInternal -Recurse -Force }
} catch {
    if ($launched -and -not $launched.HasExited) { Stop-Process -Id $launched.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $newExe) { Remove-Item -LiteralPath $newExe -Force }
    if (Test-Path -LiteralPath $newInternal) { Remove-Item -LiteralPath $newInternal -Recurse -Force }
    if (Test-Path -LiteralPath $backupExe) { Move-Item -LiteralPath $backupExe -Destination $newExe }
    if (Test-Path -LiteralPath $backupInternal) { Move-Item -LiteralPath $backupInternal -Destination $newInternal }
    Start-Process -FilePath $newExe -WorkingDirectory $installDir
    throw
} finally {
    if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
}
'''


update_manager = UpdateManager()
update_restart_requested = update_manager.restart_requested
