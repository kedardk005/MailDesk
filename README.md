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
| Frontend | React + Vite + Tailwind CSS + React Router |
| Backend | Node.js + Express.js |
| Database | MongoDB Atlas + Mongoose |
| Authentication | JWT (JSON Web Tokens) |
| Gmail Integration | Gmail API + Google OAuth 2.0 |
| Real-time | Socket.io |
| Email Notifications | Nodemailer |
| Cron Jobs | node-cron |

---

## 👥 User Roles

| Role | Permissions |
|---|---|
| **Admin** | Full control — manage users, view all emails & tasks, generate reports, connect/disconnect Gmail |
| **Head** | View all emails, create and assign tasks to employees, receive completion/delay notifications |
| **Employee** | View assigned emails & tasks only, mark tasks as complete |

---

## 📁 Project Structure

```
maildesk/
├── client/                          # React Vite Frontend
│   ├── src/
│   │   ├── api/
│   │   │   └── axios.js             # Axios instance with JWT interceptor
│   │   ├── components/
│   │   │   ├── Navbar.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   └── NotificationBell.jsx
│   │   ├── pages/
│   │   │   ├── Landing.jsx          # Public landing page
│   │   │   ├── Login.jsx
│   │   │   ├── Register.jsx
│   │   │   ├── Dashboard.jsx        # Role-based dashboard
│   │   │   ├── EmailInbox.jsx       # Centralized inbox
│   │   │   ├── TaskList.jsx         # Task management
│   │   │   └── admin/
│   │   │       ├── ManageUsers.jsx  # User management (Admin only)
│   │   │       └── Reports.jsx      # Analytics (Admin only)
│   │   └── utils/
│   │       ├── cursorEffects.js
│   │       ├── tiltEffect.js
│   │       └── scrollAnimations.js
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
│   │   └── Client.js
│   ├── routes/
│   │   ├── authRoutes.js
│   │   ├── userRoutes.js
│   │   ├── gmailRoutes.js
│   │   ├── taskRoutes.js
│   │   ├── notificationRoutes.js
│   │   └── reportsRoutes.js
│   ├── utils/
│   │   ├── notificationHelper.js
│   │   ├── emailHelper.js           # Nodemailer setup
│   │   └── cronJobs.js              # Deadline checker
│   ├── seeders/
│   │   └── clientSeeder.js
│   └── index.js                     # Express server entry point
│
├── .env
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
git clone https://github.com/yourusername/maildesk.git
cd maildesk
```

### 2. Setup Environment Variables

Create a `.env` file in the `/server` directory:

```env
PORT=5001
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5001/api/gmail/oauth/callback
SENDER_EMAIL=your_sender_gmail@gmail.com
SENDER_APP_PASSWORD=your_gmail_app_password
```

### 3. Install Dependencies

```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

### 4. Run the App

```bash
# Start backend (from /server)
npm run dev

# Start frontend (from /client)
npm run dev
```

- Backend runs on: `http://localhost:5001`
- Frontend runs on: `http://localhost:5173`

---

## 🔑 Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project
3. Enable **Gmail API** under APIs & Services
4. Configure **OAuth Consent Screen** (External)
5. Create **OAuth 2.0 Credentials** (Web Application)
   - Authorized redirect URI: `http://localhost:5001/api/gmail/oauth/callback`
6. Copy **Client ID** and **Client Secret** to `.env`

---

## 📮 API Endpoints

### Auth
| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| GET | `/api/auth/me` | Protected |

### Users
| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/users` | Admin |
| POST | `/api/users` | Admin |
| PUT | `/api/users/:id` | Admin |
| DELETE | `/api/users/:id` | Admin |

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
| GET | `/api/tasks` | Protected |
| POST | `/api/tasks` | Admin, Head |
| PUT | `/api/tasks/:id` | Protected |
| DELETE | `/api/tasks/:id` | Admin, Head |
| GET | `/api/tasks/clients` | Protected |

### Notifications
| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/notifications` | Protected |
| PUT | `/api/notifications/read-all` | Protected |
| PUT | `/api/notifications/:id/read` | Protected |

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
| Task goes past deadline | Employee + Head + Admin | In-app + Email |

---

## 📊 Reports

- **Overall Stats** — Total users, emails, tasks, pending, completed, late counts
- **Employee Performance** — Per-employee breakdown with completion rate and progress bar
- **Task Timeline** — Line chart of tasks created over last 30 days
- **CSV Export** — Download any report as a CSV file

---

## 🌐 Environment Notes

> ⚠️ If `mongodb+srv://` connection string doesn't work (common with some ISPs in India), use the direct connection string from Atlas → Connect → Shell. It starts with `mongodb://` and includes shard addresses.

> ⚠️ For Nodemailer, use a Gmail **App Password** (not your regular Gmail password). Go to Google Account → Security → 2-Step Verification → App Passwords to generate one.

---

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

---

## 📄 License

[MIT](https://choosealicense.com/licenses/mit/)

---

## 👤 Author

**Kedar Kothari**  
B.Tech Computer Engineering — CHARUSAT University  
[GitHub](https://github.com/yourusername) · [LinkedIn](https://linkedin.com/in/yourprofile)

---

<p align="center">Built with ❤️ by Kedar Kothari</p>
