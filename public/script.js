document.addEventListener("DOMContentLoaded", () => {

    const boxNameMap = {
        "HMXTKE6BEJHBJ0317": "OTOD2",
        "HQDZKE6BCJEBB1231": "SmartIV"
    };
    let filterApplied = false;

    let appliedFilters = {
        type: "ALL",
        boxCode: "",
        from: "",
        to: "",
        status: "all"
    };
    function parseTS(ts) {
        const [d, t] = ts.split(" ");
        const [day, mon, yr] = d.split("/");
        return new Date(`${yr}-${mon}-${day}T${t}`);
    }

    function formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h) return `${h}h ${m % 60}m`;
        if (m) return `${m}m ${s % 60}s`;
        return `${s}s`;
    }
    function setDefaultFromDate() {
        const input = document.getElementById("fromFilter");

        const now = new Date();

        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");


        input.value = `${yyyy}-${mm}-${dd}T00:00`;
    }
    async function loadFilters() {
        try {
            const res = await fetch("/filters");
            const data = await res.json();

            const boxSelect = document.getElementById("boxCodeFilter");


            // Reset options
            boxSelect.innerHTML = '<option value="">All Box Codes</option>';


            data.boxCodes.forEach(code => {
                if (code) {
                    const displayName = boxNameMap[code] || code;

                    boxSelect.innerHTML += `
            <option value="${code}">
                ${displayName}
            </option>
        `;
                }
            });


        } catch (err) {
            console.error("Failed to load filters:", err);
        }
    }
    async function loadLogs(showAll = false) {


        const { type, boxCode, from, to, status } = appliedFilters;

        const res = await fetch(
            `/logs?type=${type}&boxCode=${boxCode}&from=${from}&to=${to}&status=${status}`
        );
        let logs = await res.json();


        logs = logs.sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
        );

        if (
            !showAll &&
            type === "ALL" &&
            !boxCode &&
            !from &&
            !to &&
            status === "all"
        ) {
            logs = logs.slice(0, 5);
        }

        const normalize = (ts) => {
            const [date, time] = ts.split(" ");
            const [day, month, year] = date.split("/");
            return new Date(`${year}-${month}-${day}T${time}`);
        };

        let html = "";
        let totalOnlineMs = 0;
        let totalOfflineMs = 0;

        for (let i = 0; i < logs.length; i++) {

            const current = logs[i];
            const selectedStatus = appliedFilters.status;

            if (
                selectedStatus !== "all" &&
                current.online_status !== selectedStatus
            ) {
                continue;
            }
            const currentTime = normalize(current.timestamp)?.getTime();

            let duration = "-";



            if (currentTime) {
                let nextTime = null;

                for (let j = i - 1; j >= 0; j--) {
                    if (
                        logs[j].boxCode === current.boxCode &&
                        logs[j].source === current.source
                    ) {
                        nextTime = normalize(logs[j].timestamp)?.getTime();
                        break;
                    }
                }

                let durationMs = 0;

                if (nextTime && nextTime > currentTime) {
                    durationMs = nextTime - currentTime;
                    duration = formatDuration(durationMs);
                } else {
                    durationMs = Math.max(0, Date.now() - currentTime);
                    duration = formatDuration(durationMs);
                }


                if (current.online_status === "online") {
                    totalOnlineMs += durationMs;
                } else if (current.online_status === "offline") {
                    totalOfflineMs += durationMs;
                }
            }

            html += `
    <tr>
       <td>${boxNameMap[current.boxCode] || current.boxCode}</td>
        <td>${current.source}</td>
        <td class="${current.online_status}">
            ${current.online_status}
        </td>
        <td>${current.timestamp}</td>
        <td>${duration}</td>
    </tr>`;
        }
        // Count rows shown in table
        const totalRows = html ? html.split("<tr>").length - 1 : 0;

        //  Sum ALL durations (online + offline)
        const totalDurationMs = totalOnlineMs + totalOfflineMs;

        //  Update cards
        document.getElementById("totalRows").innerText = totalRows;
        document.getElementById("totalDuration").innerText = formatDuration(totalDurationMs);
        document.getElementById("logTable").innerHTML = html;
        document.getElementById("logTable").innerHTML = html;
        const title = document.getElementById("totalRowsTitle");

        if (appliedFilters.status === "online") {
            title.innerText = "Total Online";
            title.style.color = "#16a34a";
            value.style.color = "#16a34a";
        } else if (appliedFilters.status === "offline") {
            title.innerText = "Total Offline";
            title.style.color = "#dc2626";
            value.style.color = "#dc2626";
        } else {
            title.innerText = "Total Rows";
            title.style.color = "";
            value.style.color = "";
        }
    }

    async function loadLiveStatus() {

        try {
            const res = await fetch("/boxes");
            const data = await res.json();

            // Safe fallback
            const rows = data.boxes || [];
            const summary = data.summary || {
                ai: { total: 0, online: 0, offline: 0 },
                node: { total: 0, online: 0, offline: 0 }
            };

            // ================= LIVE TABLE =================
            document.getElementById("liveTable").innerHTML =
                rows.map((row, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td>${boxNameMap[row.site] || row.site}</td>

                    <td class="${row.aiBoxStatus || "offline"}">
                        ${row.aiBoxStatus || "offline"}
                    </td>
                    <td>${row.aiBoxLast || "-"}</td>

                    <td class="${row.mediaStatus || "stopped"}">
                        ${row.mediaStatus || "stopped"}
                    </td>
                    <td>${row.mediaLast || "-"}</td>

                    <td class="${row.aiServerStatus || "stopped"}">
                        ${row.aiServerStatus || "stopped"}
                    </td>
                    <td>${row.aiServerLast || "-"}</td>

                    <td class="${row.nodeStatus || "offline"}">
                        ${row.nodeStatus || "offline"}
                    </td>
                    <td>${row.nodeLast || "-"}</td>
                </tr>
            `).join("");

            // ================= SUMMARY CARDS =================

            document.getElementById("aiTotalHB").innerText =
                summary.ai.total;

            document.getElementById("aiOnlineDuration").innerText =
                summary.ai.online;

            document.getElementById("aiOfflineDuration").innerText =
                summary.ai.offline;

            document.getElementById("nodeTotalHB").innerText =
                summary.node.total;

            document.getElementById("nodeOnlineDuration").innerText =
                summary.node.online;

            document.getElementById("nodeOfflineDuration").innerText =
                summary.node.offline;

        } catch (err) {
            console.error("Live status load failed:", err);
        }
    }
    // async function loadStats() {

    //     const type = document.getElementById("typeFilter").value;
    //     const boxCode = document.getElementById("boxCodeFilter").value;
    //     const from = document.getElementById("fromFilter").value;
    //     const to = document.getElementById("toFilter").value;
    //     const status = document.getElementById("statusFilter").value;


    //     // Still fetch logs so filter stays functional
    //     await fetch(
    //         `/logs?type=${type}&boxCode=${boxCode}&from=${from}&to=${to}&status=${status}`
    //     );
    // }
    function applyFilter() {

        appliedFilters.type = document.getElementById("typeFilter").value;
        appliedFilters.boxCode = document.getElementById("boxCodeFilter").value;
        appliedFilters.from = document.getElementById("fromFilter").value;
        appliedFilters.to = document.getElementById("toFilter").value;
        appliedFilters.status = document.getElementById("statusFilter").value;

        const noFilterSelected =
            appliedFilters.type === "ALL" &&
            !appliedFilters.boxCode &&
            !appliedFilters.from &&
            !appliedFilters.to &&
            appliedFilters.status === "all";

        if (noFilterSelected) {
            filterApplied = false;
            loadLogs(false);
        } else {
            filterApplied = true;
            loadLogs(true);
        }
    }
    function resetFilter() {

        filterApplied = false;

        appliedFilters = {
            type: "ALL",
            boxCode: "",
            from: "",
            to: "",
            status: "all"
        };

        document.getElementById("typeFilter").value = "ALL";
        document.getElementById("boxCodeFilter").value = "";
        document.getElementById("fromFilter").value = "";
        document.getElementById("toFilter").value = "";
        document.getElementById("statusFilter").value = "all";

        setDefaultFromDate();

        loadLogs(false);
    }
    loadFilters();
    loadLiveStatus();

    // Delay to override browser restore
    setTimeout(() => {
        const fromInput = document.getElementById("fromFilter");
        fromInput.value = "";
        setDefaultFromDate();
    }, 0);

    loadLogs(false);

    // Auto Refresh
    setInterval(() => {

        loadLiveStatus();

        if (filterApplied) {
            loadLogs(true);   // keep showing filtered data
        } else {
            loadLogs(false);  // show latest 5 logs
        }

    }, 5000);
    window.applyFilter = applyFilter;
    window.resetFilter = resetFilter;
});