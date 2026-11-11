#!/usr/bin/env bash
# What the tablet itself says about the things that cost latency: camera modes, heat, clocks, display.
# Needs the tablet paired for wireless debugging:  adb pair <ip:pairport> <code>  then  adb connect <ip:port>
ADB=${ADB:-adb}
sh() { "$ADB" shell "$@" 2>/dev/null; }
echo "== device";   sh 'echo $(getprop ro.product.model) · Android $(getprop ro.build.version.release) · $(getprop ro.board.platform) · One UI $(getprop ro.build.version.oneui)'
echo "== chrome";   sh dumpsys package com.android.chrome | grep -m1 versionName
echo "== display";  sh dumpsys display | grep -m3 -iE "mActiveRenderFrameRate|refreshRate=|mDefaultModeId|fps=" 
echo "== thermal";  sh dumpsys thermalservice | grep -iE "Thermal Status|mValue=.*(CPU|GPU|SKIN|AP)" | head -12
echo "== battery";  sh dumpsys battery | grep -E "level|temperature|powered|status"
echo "== power";    sh 'settings get global low_power; dumpsys power | grep -m2 -iE "mIsPowered|adaptive"'
echo "== cpu MHz";  sh 'for c in /sys/devices/system/cpu/cpu[0-7]; do echo -n "$(( $(cat $c/cpufreq/scaling_cur_freq) / 1000 ))/$(( $(cat $c/cpufreq/cpuinfo_max_freq) / 1000 )) "; done; echo'
echo "== gpu";      sh 'cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage /sys/class/kgsl/kgsl-3d0/gpuclk 2>&1 | head -2'
echo "== cameras (fps ranges, high-speed modes)"
sh dumpsys media.camera | grep -E "^== Camera HAL device|Facing:|android.control.aeAvailableTargetFpsRanges|availableHighSpeedVideoConfigurations|android.info.supportedHardwareLevel|android.sync.maxLatency" -A2 | grep -vE "^--$" | head -60
echo "== devtools"; "$ADB" forward tcp:9333 localabstract:chrome_devtools_remote >/dev/null && curl -s http://127.0.0.1:9333/json/version | head -5
