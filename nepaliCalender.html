<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nepal Academic Calendar Generator</title>
    
    <!-- Firebase SDK v9 (Modular) -->
    <script type="module">
        import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
        import { 
            getFirestore, 
            doc, 
            setDoc, 
            writeBatch,
            serverTimestamp 
        } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
        import { 
            getAuth, 
            signInWithEmailAndPassword,
            onAuthStateChanged,
            signOut 
        } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

        // ===== FIREBASE CONFIGURATION (PLACEHOLDERS - REPLACE WITH YOURS) =====
        const firebaseConfig = {
            apiKey: "AIzaSyBJ_G5o4otg7riemfJDMOcPoHoIVH7emsc",
            authDomain: "geobazarr.firebaseapp.com",
            databaseURL: "https://geobazarr-default-rtdb.firebaseio.com",
            projectId: "geobazarr",
            storageBucket: "geobazarr.firebasestorage.app",
            messagingSenderId: "679949247383",
            appId: "1:679949247383:web:036d4f32038422ebb89ad2"
        };
        // ===== END FIREBASE CONFIG =====

        // Initialize Firebase
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const auth = getAuth(app);

        // ===== CALENDAR DATA (HARDCODED FOR 2083 BS) =====
        const YEAR = 2083;
        const MONTHS_DATA = [
            { "monthIndex": 1, "monthName": "Baisakh", "daysInMonth": 31, "startWeekday": "Wednesday" },
            { "monthIndex": 2, "monthName": "Jestha", "daysInMonth": 32, "startWeekday": "Friday" },
            { "monthIndex": 3, "monthName": "Ashar", "daysInMonth": 31, "startWeekday": "Sunday" },
            { "monthIndex": 4, "monthName": "Shrawan", "daysInMonth": 31, "startWeekday": "Wednesday" },
            { "monthIndex": 5, "monthName": "Bhadra", "daysInMonth": 31, "startWeekday": "Saturday" },
            { "monthIndex": 6, "monthName": "Asoj", "daysInMonth": 30, "startWeekday": "Tuesday" },
            { "monthIndex": 7, "monthName": "Kartik", "daysInMonth": 30, "startWeekday": "Thursday" },
            { "monthIndex": 8, "monthName": "Mangsir", "daysInMonth": 29, "startWeekday": "Saturday" },
            { "monthIndex": 9, "monthName": "Poush", "daysInMonth": 29, "startWeekday": "Sunday" },
            { "monthIndex": 10, "monthName": "Magh", "daysInMonth": 30, "startWeekday": "Monday" },
            { "monthIndex": 11, "monthName": "Falgun", "daysInMonth": 29, "startWeekday": "Wednesday" },
            { "monthIndex": 12, "monthName": "Chaitra", "daysInMonth": 30, "startWeekday": "Thursday" }
        ];

        // Weekday mapping
        const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const WEEKDAY_INDEX = {
            "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3,
            "Thursday": 4, "Friday": 5, "Saturday": 6
        };

        // ===== UI ELEMENTS =====
        let loginForm, calendarForm, statusDiv, authStatus, generateBtn, logoutBtn;

        // ===== AUTH STATE MANAGEMENT =====
        onAuthStateChanged(auth, (user) => {
            if (user) {
                showCalendarForm();
                authStatus.textContent = `Signed in as: ${user.email}`;
                logoutBtn.style.display = 'inline-block';
            } else {
                showLoginForm();
                authStatus.textContent = 'Not signed in';
                logoutBtn.style.display = 'none';
            }
        });

        // ===== GENERATE CALENDAR FUNCTION =====
        async function generateCalendar() {
            if (!auth.currentUser) {
                showError("Please sign in first");
                return;
            }

            const generateBtn = document.getElementById('generateBtn');
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
            showStatus('Starting calendar generation...', 'info');

            try {
                // Create batch for atomic writes
                const batch = writeBatch(db);
                
                // ===== 1. CREATE META DOCUMENT =====
                const metaRef = doc(db, `academicCalendar/${YEAR}/meta`, 'info');
                const metaData = {
                    year: YEAR,
                    weekStartsOn: "Sunday",
                    weekendDay: "Saturday",
                    totalMonths: 12,
                    generatedBy: auth.currentUser.email,
                    generatedAt: serverTimestamp(),
                    lastUpdated: serverTimestamp()
                };
                batch.set(metaRef, metaData, { merge: true });
                showStatus('Creating meta document...', 'info');

                // ===== 2. CREATE MONTH DOCUMENTS =====
                let monthCount = 0;
                
                for (const month of MONTHS_DATA) {
                    const monthRef = doc(db, `academicCalendar/${YEAR}/months`, month.monthIndex.toString());
                    
                    // Generate days array
                    const daysArray = generateDaysArray(
                        month.daysInMonth,
                        WEEKDAY_INDEX[month.startWeekday]
                    );
                    
                    const monthData = {
                        monthIndex: month.monthIndex,
                        monthName: month.monthName,
                        daysInMonth: month.daysInMonth,
                        startWeekday: month.startWeekday,
                        days: daysArray,
                        updatedAt: serverTimestamp()
                    };
                    
                    batch.set(monthRef, monthData, { merge: true });
                    monthCount++;
                    
                    // Update status every 3 months
                    if (monthCount % 3 === 0) {
                        showStatus(`Generated ${monthCount} of 12 months...`, 'info');
                    }
                }

                // ===== 3. COMMIT BATCH =====
                showStatus('Writing to Firestore...', 'info');
                await batch.commit();
                
                // ===== 4. VERIFICATION =====
                showStatus('Calendar generated successfully! Verifying...', 'success');
                
                // Show summary
                setTimeout(() => {
                    showStatus(
                        `✓ Academic Calendar ${YEAR} BS created successfully!<br>` +
                        `✓ Created 1 meta document<br>` +
                        `✓ Created ${MONTHS_DATA.length} month documents<br>` +
                        `✓ Total days: ${MONTHS_DATA.reduce((sum, m) => sum + m.daysInMonth, 0)}<br>` +
                        `✓ Week starts on: Sunday<br>` +
                        `✓ Weekend day: Saturday`,
                        'success'
                    );
                    generateBtn.disabled = false;
                    generateBtn.textContent = 'Generate Calendar Again';
                }, 1000);

            } catch (error) {
                console.error("Error generating calendar:", error);
                showError(`Failed to generate calendar: ${error.message}`);
                generateBtn.disabled = false;
                generateBtn.textContent = 'Generate Calendar';
            }
        }

        // ===== HELPER: GENERATE DAYS ARRAY =====
        function generateDaysArray(daysInMonth, startWeekdayIndex) {
            const days = [];
            
            for (let day = 1; day <= daysInMonth; day++) {
                // Calculate weekday for this day
                const weekdayIndex = (startWeekdayIndex + (day - 1)) % 7;
                const weekday = WEEKDAYS[weekdayIndex];
                
                // Determine if it's a holiday (Saturday is weekend)
                const isHoliday = weekday === "Saturday";
                
                // Create day object
                const dayObj = {
                    day: day,
                    isHoliday: isHoliday,
                    note: isHoliday ? "Weekend (Saturday)" : "",
                    weekday: weekday // Stored for reference but can be derived
                };
                
                days.push(dayObj);
            }
            
            return days;
        }

        // ===== HELPER: SHOW STATUS MESSAGE =====
        function showStatus(message, type = 'info') {
            statusDiv.innerHTML = `
                <div class="status-${type}">
                    ${message}
                </div>
            `;
            statusDiv.style.display = 'block';
            
            // Auto-hide info messages after 5 seconds
            if (type === 'info') {
                setTimeout(() => {
                    if (statusDiv.innerHTML.includes(message)) {
                        statusDiv.style.display = 'none';
                    }
                }, 5000);
            }
        }

        function showError(message) {
            showStatus(message, 'error');
        }

        // ===== UI MANAGEMENT =====
        function showLoginForm() {
            loginForm.style.display = 'block';
            calendarForm.style.display = 'none';
        }

        function showCalendarForm() {
            loginForm.style.display = 'none';
            calendarForm.style.display = 'block';
        }

        // ===== EVENT LISTENERS =====
        document.addEventListener('DOMContentLoaded', () => {
            // Get UI elements
            loginForm = document.getElementById('loginForm');
            calendarForm = document.getElementById('calendarForm');
            statusDiv = document.getElementById('status');
            authStatus = document.getElementById('authStatus');
            generateBtn = document.getElementById('generateBtn');
            logoutBtn = document.getElementById('logoutBtn');

            // Login form submission
            document.getElementById('loginBtn').addEventListener('click', async () => {
                const email = document.getElementById('email').value;
                const password = document.getElementById('password').value;
                
                if (!email || !password) {
                    showError('Please enter email and password');
                    return;
                }
                
                try {
                    await signInWithEmailAndPassword(auth, email, password);
                    showStatus('Signed in successfully!', 'success');
                } catch (error) {
                    showError(`Login failed: ${error.message}`);
                }
            });

            // Generate calendar button
            generateBtn.addEventListener('click', generateCalendar);

            // Logout button
            logoutBtn.addEventListener('click', async () => {
                try {
                    await signOut(auth);
                    showStatus('Signed out successfully', 'success');
                } catch (error) {
                    showError(`Logout failed: ${error.message}`);
                }
            });

            // Enter key for login
            document.getElementById('password').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    document.getElementById('loginBtn').click();
                }
            });
        });

        // Make function available globally for button onclick
        window.generateCalendar = generateCalendar;
    </script>

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        body {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }

        .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            width: 100%;
            max-width: 800px;
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .content {
            padding: 40px;
        }

        .auth-status {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .auth-status span {
            font-weight: 600;
            color: #495057;
        }

        .form-container {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 30px;
            margin-bottom: 20px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #495057;
        }

        .form-group input {
            width: 100%;
            padding: 12px 15px;
            border: 2px solid #e9ecef;
            border-radius: 6px;
            font-size: 16px;
            transition: border-color 0.3s;
        }

        .form-group input:focus {
            outline: none;
            border-color: #667eea;
        }

        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 14px 28px;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            display: inline-block;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }

        .btn:active {
            transform: translateY(0);
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none !important;
            box-shadow: none !important;
        }

        .btn-logout {
            background: #dc3545;
            padding: 8px 16px;
            font-size: 14px;
        }

        .btn-logout:hover {
            box-shadow: 0 5px 15px rgba(220, 53, 69, 0.4);
        }

        .calendar-info {
            background: #e8f4ff;
            border: 1px solid #b3d9ff;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
        }

        .calendar-info h3 {
            color: #0066cc;
            margin-bottom: 15px;
            font-size: 1.3rem;
        }

        .calendar-info ul {
            list-style: none;
            padding-left: 20px;
        }

        .calendar-info li {
            margin-bottom: 10px;
            padding-left: 10px;
            position: relative;
        }

        .calendar-info li:before {
            content: "✓";
            color: #28a745;
            font-weight: bold;
            position: absolute;
            left: -15px;
        }

        .status-box {
            border-radius: 8px;
            padding: 20px;
            margin-top: 20px;
            display: none;
        }

        .status-info {
            background: #e8f4ff;
            border: 1px solid #b3d9ff;
            color: #0066cc;
        }

        .status-success {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            color: #155724;
        }

        .status-error {
            background: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
        }

        .warning {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            color: #856404;
            padding: 15px;
            border-radius: 6px;
            margin-top: 20px;
            font-size: 0.9rem;
        }

        .firebase-config {
            background: #f5f5f5;
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 15px;
            margin-top: 20px;
            font-family: monospace;
            font-size: 0.85rem;
            color: #666;
        }

        .firebase-config h4 {
            color: #333;
            margin-bottom: 10px;
        }

        @media (max-width: 768px) {
            .container {
                border-radius: 8px;
            }
            
            .header {
                padding: 20px;
            }
            
            .header h1 {
                font-size: 2rem;
            }
            
            .content {
                padding: 20px;
            }
            
            .auth-status {
                flex-direction: column;
                gap: 10px;
                text-align: center;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🇳🇵 Nepal Academic Calendar Generator</h1>
            <p>Firestore Data Generator for 2083 BS</p>
        </div>
        
        <div class="content">
            <div class="auth-status">
                <span id="authStatus">Checking authentication status...</span>
                <button id="logoutBtn" class="btn btn-logout" style="display: none;">Sign Out</button>
            </div>
            
            <div id="loginForm" class="form-container" style="display: none;">
                <h2>Sign In Required</h2>
                <p style="margin-bottom: 20px; color: #666;">
                    You need to sign in to generate the academic calendar data.
                </p>
                
                <div class="form-group">
                    <label for="email">Email Address</label>
                    <input type="email" id="email" placeholder="admin@example.com">
                </div>
                
                <div class="form-group">
                    <label for="password">Password</label>
                    <input type="password" id="password" placeholder="••••••••">
                </div>
                
                <button id="loginBtn" class="btn">Sign In</button>
                
                <div class="warning">
                    <strong>Note:</strong> This page requires Firebase Authentication. 
                    Make sure your Firestore rules allow write access for authenticated users.
                </div>
            </div>
            
            <div id="calendarForm" class="form-container" style="display: none;">
                <h2>Generate Academic Calendar 2083 BS</h2>
                
                <div class="calendar-info">
                    <h3>Calendar Specifications</h3>
                    <ul>
                        <li><strong>Year:</strong> 2083 BS</li>
                        <li><strong>Week starts on:</strong> Sunday</li>
                        <li><strong>Weekend day:</strong> Saturday</li>
                        <li><strong>Total months:</strong> 12</li>
                        <li><strong>Firestore path:</strong> academicCalendar/2083/</li>
                        <li><strong>Weekdays are derived</strong> from startWeekday (not stored per day)</li>
                    </ul>
                </div>
                
                <p style="margin-bottom: 20px; color: #666;">
                    Click the button below to generate/overwrite the academic calendar data for 2083 BS.
                    This will create 1 meta document and 12 month documents in Firestore.
                </p>
                
                <button id="generateBtn" class="btn">Generate Calendar 2083 BS</button>
                
                <div id="status" class="status-box"></div>
                
                <div class="warning">
                    <strong>Warning:</strong> This will overwrite existing data at academicCalendar/2083/.
                    Make sure you want to replace the current calendar data.
                </div>
            </div>
            
            <div class="firebase-config">
                <h4>Firebase Configuration Used:</h4>
                <code>
                    Project: geobazarr<br>
                    Database: Firestore<br>
                    Collection: academicCalendar/{year}/<br>
                    Authentication: Enabled<br>
                    Rules: Assumed to allow writes for authenticated users
                </code>
            </div>
        </div>
    </div>
</body>
</html>
