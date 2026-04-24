document.addEventListener("DOMContentLoaded", () => {
    let usersCache = [];

    async function loadCurrentUser() {
        try {
            const res = await fetch("/me");

            if (!res.ok) {
                window.location.href = "/login.html";
                return null;
            }

            const data = await res.json();
            return data.user;
        } catch (err) {
            window.location.href = "/login.html";
            return null;
        }
    }

    async function logout() {
        try {
            await fetch("/logout", { method: "POST" });
        } catch (err) {
            console.error("Logout failed:", err);
        }
        window.location.href = "/login.html";
    }

    function formatDateTime(value) {
        if (!value) return "-";
        return new Date(value).toLocaleString("en-GB", {
            timeZone: "Asia/Bangkok",
            hour12: false
        }).replace(",", "");
    }

    function renderSummary(users) {
        const totalUsers = users.length;
        const adminUsers = users.filter(user => user.role === "admin").length;
        const normalUsers = users.filter(user => user.role === "user").length;

        document.getElementById("totalUsers").innerText = totalUsers;
        document.getElementById("adminUsers").innerText = adminUsers;
        document.getElementById("normalUsers").innerText = normalUsers;
    }

    function renderUsers(users) {
        const table = document.getElementById("userTable");

        if (!users.length) {
            table.innerHTML = `<tr><td colspan="7">No users found.</td></tr>`;
            return;
        }

        table.innerHTML = users.map((user, index) => {
            const statusText = user.isActive ? "Active" : "Inactive";
            const statusClass = user.isActive ? "online" : "offline";

            const actions = (() => {
                if (currentUserRole === "super-admin") {
                    return `
            <button class="btn-secondary edit-user-btn" data-id="${user.id}">Edit</button>
            <button class="btn-secondary btn-danger remove-user-btn" data-id="${user.id}">Remove</button>
        `;
                }

                if (currentUserRole === "admin") {
                    if (user.role === "user") {
                        return `
                <button class="btn-secondary edit-user-btn" data-id="${user.id}">Edit</button>
                <button class="btn-secondary btn-danger remove-user-btn" data-id="${user.id}">Remove</button>
            `;
                    }

                    return `<span style="color:#6b7280;font-weight:600;">Protected</span>`;
                }

                return `<span style="color:#6b7280;font-weight:600;">Protected</span>`;
            })();

            return `
                <tr>
                    <td>${index + 1}</td>
                    <td>${user.username}</td>
                    <td>${user.role}</td>
                    <td class="${statusClass}">${statusText}</td>
                    <td>${formatDateTime(user.createdAt)}</td>
                    <td>${formatDateTime(user.updatedAt)}</td>
                    <td>${actions}</td>
                </tr>
            `;
        }).join("");

        document.querySelectorAll(".edit-user-btn").forEach(button => {
            button.addEventListener("click", () => {
                openEditUserModal(button.dataset.id);
            });
        });

        document.querySelectorAll(".remove-user-btn").forEach(button => {
            button.addEventListener("click", () => {
                removeUser(button.dataset.id);
            });
        });
    }

    async function loadUsers() {
        try {
            const res = await fetch("/users");
            const data = await res.json();

            if (!res.ok) {
                alert(data.error || "Failed to load users");
                return;
            }

            usersCache = data.users || [];
            renderSummary(usersCache);
            renderUsers(usersCache);
        } catch (err) {
            console.error("Load users failed:", err);
            alert("Failed to load users");
        }
    }

    function openCreateUserModal() {
        document.getElementById("createUserModal").classList.remove("hidden");
        document.getElementById("createUserMessage").innerText = "";
    }

    function closeCreateUserModal() {
        document.getElementById("createUserModal").classList.add("hidden");
        document.getElementById("newUsernameInput").value = "";
        document.getElementById("newPasswordInput").value = "";
        document.getElementById("confirmPasswordInput").value = "";
        document.getElementById("createUserMessage").innerText = "";
    }

    async function createUserAccount() {
        const username = document.getElementById("newUsernameInput").value.trim();
        const password = document.getElementById("newPasswordInput").value;
        const confirmPassword = document.getElementById("confirmPasswordInput").value;
        const msg = document.getElementById("createUserMessage");
        const role = document.getElementById("newRoleInput").value;

        msg.innerText = "";

        if (!username || !password || !confirmPassword) {
            msg.style.color = "red";
            msg.innerText = "All fields are required";
            return;
        }

        if (password !== confirmPassword) {
            msg.style.color = "red";
            msg.innerText = "Passwords do not match";
            return;
        }

        try {
            const res = await fetch("/users", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ username, password, role })
            });

            const data = await res.json();

            if (!res.ok) {
                msg.style.color = "red";
                msg.innerText = data.error || "Failed to create user";
                return;
            }

            msg.style.color = "green";
            msg.innerText = data.message || "User created successfully";

            await loadUsers();

            setTimeout(() => {
                closeCreateUserModal();
            }, 800);
        } catch (err) {
            msg.style.color = "red";
            msg.innerText = "Network error";
        }
    }

    function openEditUserModal(userId) {
        const user = usersCache.find(item => item.id === userId);
        if (!user) return;

        document.getElementById("editUserId").value = user.id;
        document.getElementById("editUsernameInput").value = user.username;
        document.getElementById("editPasswordInput").value = "";
        document.getElementById("editConfirmPasswordInput").value = "";
        document.getElementById("editUserMessage").innerText = "";

        document.getElementById("editUserModal").classList.remove("hidden");
    }

    function closeEditUserModal() {
        document.getElementById("editUserModal").classList.add("hidden");
        document.getElementById("editUserId").value = "";
        document.getElementById("editUsernameInput").value = "";
        document.getElementById("editPasswordInput").value = "";
        document.getElementById("editConfirmPasswordInput").value = "";
        document.getElementById("editUserMessage").innerText = "";
    }

    async function saveEditedUser() {
        const id = document.getElementById("editUserId").value;
        const username = document.getElementById("editUsernameInput").value.trim();
        const password = document.getElementById("editPasswordInput").value;
        const confirmPassword = document.getElementById("editConfirmPasswordInput").value;
        const msg = document.getElementById("editUserMessage");

        msg.innerText = "";

        if (!username) {
            msg.style.color = "red";
            msg.innerText = "Username is required";
            return;
        }

        if ((password || confirmPassword) && password !== confirmPassword) {
            msg.style.color = "red";
            msg.innerText = "Passwords do not match";
            return;
        }

        try {
            const res = await fetch(`/users/${id}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (!res.ok) {
                msg.style.color = "red";
                msg.innerText = data.error || "Failed to update user";
                return;
            }

            msg.style.color = "green";
            msg.innerText = data.message || "User updated successfully";

            await loadUsers();

            setTimeout(() => {
                closeEditUserModal();
            }, 800);
        } catch (err) {
            msg.style.color = "red";
            msg.innerText = "Network error";
        }
    }

    async function removeUser(userId) {
        const confirmed = window.confirm("Are you sure you want to remove this user?");
        if (!confirmed) return;

        try {
            const res = await fetch(`/users/${userId}`, {
                method: "DELETE"
            });

            const data = await res.json();

            if (!res.ok) {
                alert(data.error || "Failed to remove user");
                return;
            }

            await loadUsers();
            alert(data.message || "User removed successfully");
        } catch (err) {
            console.error("Remove user failed:", err);
            alert("Failed to remove user");
        }
    }

    function setupPasswordToggles() {
        document.querySelectorAll(".password-field").forEach(field => {
            const input = field.querySelector(".password-input");
            const toggle = field.querySelector(".password-toggle");
            const eyeOpen = field.querySelector(".eye-open");
            const eyeOff = field.querySelector(".eye-off");

            if (!input || !toggle || !eyeOpen || !eyeOff) return;

            toggle.addEventListener("click", () => {
                const isHidden = input.type === "password";
                input.type = isHidden ? "text" : "password";
                eyeOpen.style.display = isHidden ? "none" : "block";
                eyeOff.style.display = isHidden ? "block" : "none";
            });
        });
    }
    function populateCreateRoleOptions(role) {
        const select = document.getElementById("newRoleInput");

        if (role === "super-admin") {
            select.innerHTML = `
            <option value="user">User</option>
            <option value="admin">Admin</option>
        `;
        } else {
            select.innerHTML = `
            <option value="user">User</option>
        `;
        }
    }

    loadCurrentUser().then(async (currentUser) => {
        currentUserRole = (currentUser.role || "").trim().toLowerCase();
        populateCreateRoleOptions(currentUserRole);
        if (!currentUser) return;

        const role = (currentUser.role || "").trim().toLowerCase();

        if (role !== "admin" && role !== "super-admin") {
            window.location.href = "/";
            return;
        }

        document.getElementById("currentUsername").innerText = currentUser.username;
        await loadUsers();
    });

    document.getElementById("backToDashboardBtn").addEventListener("click", () => {
        window.location.href = "/";
    });

    document.getElementById("logoutBtn").addEventListener("click", logout);
    document.getElementById("openCreateUserBtn").addEventListener("click", openCreateUserModal);
    document.getElementById("closeCreateUserModalBtn").addEventListener("click", closeCreateUserModal);
    document.getElementById("saveNewUserBtn").addEventListener("click", createUserAccount);
    document.getElementById("closeEditUserModalBtn").addEventListener("click", closeEditUserModal);
    document.getElementById("saveEditUserBtn").addEventListener("click", saveEditedUser);

    setupPasswordToggles();
});