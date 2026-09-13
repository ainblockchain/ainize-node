# The NVIDIA driver on this machine is pinned. Do not let anything upgrade it in the background.

## What happened

`unattended-upgrades` moved the driver **580.173.02 → 580.178.04** at 06:06 on 2026-09-11.

The userspace libraries were replaced while the **running kernel module stayed at the old version**. Nothing
recovers from that state on its own:

- `nvidia-smi` → `Failed to initialize NVML: Driver/library version mismatch`
- `nvidia-container-cli` refuses to start **any new GPU container**

Containers that were already running kept serving, so nothing looked wrong until something restarted. A vLLM
server died at 06:22 and could not be brought back — and 500 benchmark transcripts recorded
`transport: fetch failed`, which reads exactly like a measurement until you open one and find `final: null`.

## How it was restored, without a reboot

All 17 of the 580.173.02 packages were still in `/var/cache/apt/archives`, so userspace was put back in step
with the kernel module:

```
cd /var/cache/apt/archives
sudo dpkg -i --force-downgrade \
  libnvidia-common-580-server_580.173.02-*.deb nvidia-firmware-580-server-580.173.02_*.deb \
  libnvidia-compute-580-server_580.173.02-*.deb libnvidia-cfg1-580-server_580.173.02-*.deb \
  libnvidia-decode-580-server_580.173.02-*.deb libnvidia-encode-580-server_580.173.02-*.deb \
  libnvidia-extra-580-server_580.173.02-*.deb libnvidia-fbc1-580-server_580.173.02-*.deb \
  libnvidia-gl-580-server_580.173.02-*.deb nvidia-compute-utils-580-server_580.173.02-*.deb \
  nvidia-utils-580-server_580.173.02-*.deb nvidia-kernel-common-580-server_580.173.02-*.deb \
  nvidia-kernel-source-580-server_580.173.02-*.deb nvidia-dkms-580-server_580.173.02-*.deb \
  xserver-xorg-video-nvidia-580-server_580.173.02-*.deb nvidia-driver-580-server_580.173.02-*.deb \
  nvidia-fabricmanager-580_580.173.02-*.deb
sudo systemctl restart nvidia-fabricmanager
```

`nvidia-fabricmanager-580` needs the same treatment separately — left at the new version it fails to start,
and on NVSwitch hardware that is not optional.

Verified afterwards: `nvidia-smi` lists all eight A100s, and `systemctl is-active nvidia-fabricmanager` is
`active`.

## The two locks, and why there are two

They fail differently, so neither alone is enough.

1. **`apt-mark hold`** on every `nvidia*` package. Stops every apt path, including someone typing
   `sudo apt upgrade` by hand. The packages now appear under "The following packages have been kept back".
2. **`/etc/apt/apt.conf.d/99-hold-nvidia`** blacklists `nvidia-`, `libnvidia-`, `linux-objects-nvidia-`,
   `linux-signatures-nvidia-` and `xserver-xorg-video-nvidia-` from the unattended timer — so the background
   path stays blocked even if a hold is lifted and forgotten.

Check both:

```
apt-mark showhold | grep nvidia
sudo apt-get -s upgrade | grep -E '^Inst.*nvidia'          # must print nothing
sudo unattended-upgrade --dry-run -v 2>&1 | grep -i blacklist
```

## When the driver really should be upgraded

It is a **scheduled human action**: install, then reboot **in the same window**. Never a background one, and
never without knowing what is holding the GPUs — check `nvidia-smi` and the running containers first.

```
sudo apt-mark unhold $(apt-mark showhold | grep nvidia | tr '\n' ' ')
sudo apt install nvidia-driver-580-server
sudo reboot
# then re-apply the holds
```
