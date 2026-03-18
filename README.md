# AI Dashboard

A web-based dashboard for monitoring and managing AI-related services and status.

## Features
- Status monitoring
- Simple web interface
- JSON-based logging

## Tech Stack
- Node.js
- Express
- HTML / CSS / JavaScript

## Setup
1. Install dependencies
   ```bash
   npm install
## Script for sending service staus in AI box server
#!/bin/bash

while true
do

BOX_CODE="HQDZKE6BCJEBB1231" (Change based on server)
NODE_RED_URL="http://192.168.102.251:1880/service-status" (Change based on server)

services=(
  "mediaserver.service"
  "aiserver.service"
)

json_services=()

for s in "${services[@]}"; do
  if systemctl is-active --quiet "$s"; then
    status="running"
  else
    status="stopped"
  fi

  json_services+=("{\"service_name\":\"$s\",\"status\":\"$status\"}")
done

payload=$(printf '{ "boxCode":"%s","services":[%s] }' \
"$BOX_CODE" "$(IFS=,; echo "${json_services[*]}")")

curl -s -X POST "$NODE_RED_URL" \
-H "Content-Type: application/json" \
-d "$payload"

sleep 60

done