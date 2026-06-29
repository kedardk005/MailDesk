# MailDesk 📧

### *Where Emails Meet Action.*

A full-stack web application for centralized company email and task management — built for teams that need structure, accountability, and real-time collaboration.

---

## 🚀 Overview

MailDesk connects your company Gmail accounts, centralizes all incoming emails, and lets managers assign tasks directly from those emails — with real-time notifications, deadline tracking, and performance reports.

Built with a role-based system (Admin, Head, Employee) so every team member sees exactly what they need.

---

## ✨ Features

- **Centralized Gmail Inbox** — Connect multiple Gmail accounts via OAuth 2.0. All emails flow into one smart inbox.
- **Email-to-Task Assignment** — Turn any email into an assigned task with one click. Link the original email to the task.
- **Role-Based Access Control** — Three roles with different permissions: Admin, Head, and Employee.
- **Real-time Notifications** — Socket.io powered live alerts when tasks are assigned, completed, or overdue.
- **Email Notifications** — Nodemailer sends email alerts to Head/Admin when tasks are completed or go overdue.
- **Deadline Tracking** — Cron job runs every minute, automatically marking overdue tasks as Late.
- **Team Analytics & Reports** — Weekly/monthly performance reports per employee with CSV export.
- **Gmail Account Management** — Connect and disconnect Gmail accounts. Fresh sync on every new connection.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + Tailwind CSS + React Router v7 |
| Backend | Node.js + Express.js v5 |
| Database | MongoDB Atlas + Mongoose |
| Authentication | JWT (JSON Web Tokens) |
| Gmail Integration | Gmail API + Google OAuth 2.0 |
| Real-time | Socket.io v4 |
| Email Notifications | Nodemailer |
| Cron Jobs | node-cron |

---

## 👥 User Roles

| Role | Permissions |
|---|---|
| **Admin** | Full control — manage users, view all emails & tasks, generate all reports, connect/disconnect Gmail |
| **Head** | View all emails, create and assign tasks to employees, view overall & timeline reports, receive completion/delay notifications |
| **Employee** | View assigned emails & tasks only, mark tasks as complete |

---

## 📁 Project Structure

```
MailDesk/
├── client/                          # React + Vite Frontend
│   ├── src/
│   │   ├── api/
│   │   │   └── axios.js             # Axios instance with JWT + 401 interceptor
│   │   ├── components/
│   │   │   ├── AdminRoute.jsx       # Admin-only route guard
│   │   │   ├── AdminOrHeadRoute.jsx # Admin + Head route guard
│   │   │   ├── ProtectedRoute.jsx   # Auth route guard
│   │   │   ├── ProtectedLayout.jsx  # Shared layout for protected pages
│   │   │   ├── Navbar.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   └── NotificationBell.jsx # Real-time Socket.io notifications
│   │   ├── pages/
│   │   │   ├── Landing.jsx          # Public landing page
│   │   │   ├── Login.jsx
│   │   │   ├── Register.jsx
│   │   │   ├── ForgotPassword.jsx
│   │   │   ├── Dashboard.jsx        # Role-based dashboard
│   │   │   ├── EmailInbox.jsx       # Centralized inbox
│   │   │   ├── TaskList.jsx         # Task management
│   │   │   ├── Profile.jsx          # User profile & password change
│   │   │   └── admin/
│   │   │       ├── ManageUsers.jsx  # User management (Admin only)
│   │   │       ├── ActivityLog.jsx  # Activity logs (Admin only)
│   │   │       └── Reports.jsx      # Analytics (Admin + Head)
│   │   └── utils/
│   │       ├── countUp.jsx
│   │       ├── cursorEffects.js
│   │       ├── moduleCursor.js
│   │       ├── scrollAnimations.js
│   │       └── tiltEffect.js
│   ├── .env                         # VITE_API_URL for dev
│   ├── .env.production              # VITE_API_URL for production
│   └── package.json
│
├── server/                          # Node.js + Express Backend
│   ├── config/
│   │   └── db.js                    # MongoDB connection
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── userController.js
│   │   ├── gmailController.js
│   │   ├── taskController.js
│   │   ├── notificationController.js
│   │   └── reportsController.js
│   ├── middleware/
│   │   └── authMiddleware.js        # JWT protect + authorizeRoles
│   ├── models/
│   │   ├── User.js
│   │   ├── Email.js
│   │   ├── Task.js
│   │   ├── Notification.js
│   │   ├── ActivityLog.js
│   │   └── Client.js
│   ├── routes/
│   │   ├── authRoutes.js
│   │   ├── userRoutes.js
│   │   ├── gmailRoutes.js
│   │   ├── taskRoutes.js
│   │   ├── notificationRoutes.js
│   │   └── reportsRoutes.js
│   ├── utils/
│   │   ├── activityLogger.js
│   │   ├── notificationHelper.js
│   │   ├── emailHelper.js           # Nodemailer setup
│   │   └── cronJobs.js              # Deadline checker + auto email sync
│   ├── seeders/
│   │   └── clientSeeder.js
│   └── index.js                     # Express server entry point
│
├── .gitignore
└── README.md
```

---

## ⚙️ Getting Started

### Prerequisites

- Node.js v18+
- MongoDB Atlas account (free tier works)
- Google Cloud Console project with Gmail API enabled
- A Gmail account for sending notifications (Nodemailer)

### 1. Clone the Repository

```bash
git clone https://github.com/kedardk005/MailDesk.git
cd MailDesk
```

### 2. Setup Server Environment Variables

Create a `.env` file inside the `/server` directory:

```env
PORT=5015
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5015/api/gmail/oauth/callback
SENDER_EMAIL=your_sender_gmail@gmail.com
SENDER_APP_PASSWORD=your_gmail_app_password
ALLOWED_ORIGINS=http://localhost:5174
```

### 3. Setup Client Environment Variables

Create a `.env` file inside the `/client` directory:

```env
VITE_API_URL=http://localhost:5015
```

### 4. Install Dependencies

```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

### 5. Run the App

```bash
# Start backend (from /server)
npm run dev

# Start frontend (from /client)
npm run dev
```

- Backend runs on: `http://localhost:5015`
- Frontend runs on: `http://localhost:5174`

---

## 🔑 Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project
3. Enable **Gmail API** under APIs & Services
4. Configure **OAuth Consent Screen** (External)
5. Create **OAuth 2.0 Credentials** (Web Application)
   - Authorized redirect URI: `http://localhost:5015/api/gmail/oauth/callback`
6. Copy **Client ID** and **Client Secret** to `server/.env`

---

## 📮 API Endpoints

### Auth

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register` | Public (Employee only) |
| POST | `/api/auth/login` | Public |
| POST | `/api/auth/forgot-password` | Public |
| GET | `/api/auth/me` | Protected |

### Users

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/users` | Admin, Head |
| POST | `/api/users` | Admin |
| PUT | `/api/users/:id` | Admin |
| DELETE | `/api/users/:id` | Admin |
| PUT | `/api/users/profile` | All roles |
| PUT | `/api/users/change-password` | All roles |
| GET | `/api/users/activity-logs` | Admin |

### Gmail

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/gmail/auth-url` | Protected |
| GET | `/api/gmail/oauth/callback` | Public |
| POST | `/api/gmail/fetch` | Protected |
| GET | `/api/gmail/emails` | Protected |
| GET | `/api/gmail/status` | Protected |
| DELETE | `/api/gmail/disconnect` | Protected |
| DELETE | `/api/gmail/emails` | Admin |
| DELETE | `/api/gmail/emails/:id` | Admin, Head |

### Tasks

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/tasks` | All roles |
| POST | `/api/tasks` | Admin, Head |
| GET | `/api/tasks/:id` | All roles |
| PUT | `/api/tasks/:id` | All roles |
| DELETE | `/api/tasks/:id` | Admin, Head |
| GET | `/api/tasks/clients` | All roles |

### Notifications

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/notifications` | All roles |
| PUT | `/api/notifications/read-all` | All roles |
| PUT | `/api/notifications/:id/read` | All roles |

### Reports

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/reports/overall` | Admin, Head |
| GET | `/api/reports/employee` | Admin |
| GET | `/api/reports/timeline` | Admin, Head |

---

## 🔔 Notification Triggers

| Event | Who Gets Notified | Channel |
|---|---|---|
| Task assigned to employee | Employee | In-app (Socket.io) |
| Employee marks task complete | Head + Admin | In-app + Email |
| Task goes past deadline | Employee + Head + Admin | In-app |

---

## 📊 Reports

- **Overall Stats** — Total users, emails, tasks, pending, completed, and late counts
- **Employee Performance** — Per-employee breakdown with completion rate (Admin only)
- **Task Timeline** — Line chart of tasks created over the last 30 days
- **CSV Export** — Download any report as a CSV file

---

## 🌐 Environment Notes

> ⚠️ If the `mongodb+srv://` connection string doesn't work (common with some ISPs in India), use the direct connection string from Atlas → Connect → Shell. It starts with `mongodb://` and includes shard addresses.

> ⚠️ For Nodemailer, use a Gmail **App Password** — not your regular Gmail password. Go to Google Account → Security → 2-Step Verification → App Passwords to generate one.

> ⚠️ Gmail OAuth connections are Admin-only. Only Admin accounts can link Gmail inboxes to MailDesk.

---

## 📄 License

[MIT](https://choosealicense.com/licenses/mit/)

---

## 👤 Author

**Kedar Kothari**  
B.Tech Computer Engineering — CHARUSAT University  
[GitHub](https://github.com/kedardk005) · [LinkedIn](https://linkedin.com/in/kedar-kothari-253b6a259)

---

<p align="center">Built with ❤️ by Kedar Kothari</p>
