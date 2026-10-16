#!/usr/bin/env bash
sleep 300 &
echo $! > "$AID_CHILD_PID_FILE"
wait
