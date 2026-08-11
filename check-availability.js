const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const { google } = require('googleapis');

const TARGET_EQUIPMENT = '3D Printer - Prusa XL 5-Toolhead'; // CHANGE THIS to test other equipment
const STATE_FILE = 'previous-state.json';
const ROW_HEIGHT = 45;       // px between equipment rows
const HOUR_WIDTH = 75;       // px per hourly column
const DAY_WIDTH = 1800;      // px per day (24 * HOUR_WIDTH)

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Google Calendar configuration
let calendar = null;
async function initializeCalendar() {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CALENDAR_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });

    calendar = google.calendar({ version: 'v3', auth });
    console.log('✅ Google Calendar initialized');
  } catch (error) {
    console.error('❌ Error initializing Google Calendar:', error);
  }
}

function getDaysAway(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const targetDate = new Date(dateStr);
  targetDate.setHours(0, 0, 0, 0);

  const diffTime = targetDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays;
}

function getNextClickCount(daysAway) {
  if (daysAway <= 2) return 0;
  return Math.floor(daysAway / 3);
}

function formatClickCount(clicks) {
  if (clicks === 0) return '';
  return ` - Click Next ${clicks} time${clicks !== 1 ? 's' : ''}`;
}

function formatHourAsTimeString(hour) {
  // hour is 0-23 (float, should be near-integer). Round to nearest.
  const h = Math.round(hour) % 24;
  const period = h >= 12 ? 'pm' : 'am';
  let displayHour = h % 12;
  if (displayHour === 0) displayHour = 12;
  return `${displayHour}:00${period}`;
}

async function updateGoogleCalendar(availableSlots) {
  if (!calendar) {
    console.log('⚠️  Google Calendar not initialized, skipping calendar update');
    return;
  }
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  try {
    const existingEvents = await calendar.events.list({
      calendarId: calendarId,
      timeMin: new Date().toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const existingEventIds = new Set();

    for (const slot of availableSlots) {
      const [timeStr, period] = slot.time.match(/(\d{1,2}:\d{2})([ap]m)/).slice(1);
      let [hours, minutes] = timeStr.split(':').map(Number);

      if (period === 'pm' && hours !== 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;

      const dateObj = new Date(slot.date);
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      const hourStr = String(hours).padStart(2, '0');
      const minStr = String(minutes).padStart(2, '0');

      const eventStartStr = `${year}-${month}-${day}T${hourStr}:${minStr}:00`;

      const endHours = hours + 1;
      const endHourStr = String(endHours).padStart(2, '0');
      const eventEndStr = `${year}-${month}-${day}T${endHourStr}:${minStr}:00`;

      const daysAway = getDaysAway(slot.date);
      const clicks = getNextClickCount(daysAway);

      const eventSummary = `${TARGET_EQUIPMENT} - Available`;
      let eventDescription = `Overnight slot available!`;
      if (clicks > 0) {
        eventDescription += `\n\nClick Next ${clicks} time${clicks !== 1 ? 's' : ''} to reach this date`;
      }
      eventDescription += `\n\nBook here: https://libcal.jocolibrary.org/reserve/makerspace`;

      const existingEvent = existingEvents.data.items?.find(event => {
        if (event.summary !== eventSummary) return false;
        return event.start.dateTime?.startsWith(eventStartStr);
      });

      if (existingEvent) {
        existingEventIds.add(existingEvent.id);
        if (existingEvent.description !== eventDescription) {
          await calendar.events.update({
            calendarId: calendarId,
            eventId: existingEvent.id,
            resource: {
              summary: eventSummary,
              description: eventDescription,
              start: {
                dateTime: eventStartStr,
                timeZone: 'America/Chicago'
              },
              end: {
                dateTime: eventEndStr,
                timeZone: 'America/Chicago'
              },
              colorId: '10'
            }
          });
          console.log(`✅ Updated calendar event for ${slot.date} at ${slot.time}`);
        } else {
          console.log(`Event already exists for ${slot.date} at ${slot.time}`);
        }
      } else {
        const event = {
          summary: eventSummary,
          description: eventDescription,
          start: {
            dateTime: eventStartStr,
            timeZone: 'America/Chicago'
          },
          end: {
            dateTime: eventEndStr,
            timeZone: 'America/Chicago'
          },
          colorId: '10'
        };

        await calendar.events.insert({
          calendarId: calendarId,
          resource: event
        });

        console.log(`✅ Created calendar event for ${slot.date} at ${slot.time}`);
      }
    }

    const now = new Date();
    if (existingEvents.data.items) {
      for (const event of existingEvents.data.items) {
        const eventStart = new Date(event.start.dateTime);
        const isPast = eventStart < now;
        const noLongerAvailable = !existingEventIds.has(event.id);

        if (isPast || noLongerAvailable) {
          await calendar.events.delete({
            calendarId: calendarId,
            eventId: event.id
          });
          if (isPast) {
            console.log(`🗑️  Deleted past event: ${event.summary} (${event.start.dateTime})`);
          } else {
            console.log(`🗑️  Deleted unavailable event: ${event.summary}`);
          }
        }
      }
    }

    console.log('✅ Google Calendar updated successfully');
  } catch (error) {
    console.error('❌ Error updating Google Calendar:', error);
  }
}

function loadPreviousState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading previous state:', error);
  }
  return { availableSlots: [], lastChecked: null };
}

function savePreviousState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('Saved current state');
  } catch (error) {
    console.error('Error saving state:', error);
  }
}

function formatDateWithDaysAway(dateStr) {
  const daysAway = getDaysAway(dateStr);

  if (daysAway === 0) {
    return `${dateStr} (TODAY)`;
  } else if (daysAway === 1) {
    return `${dateStr} (tomorrow)`;
  } else {
    return `${dateStr} (${daysAway} days away)`;
  }
}

async function sendEmail(newSlots, allSlots) {
  let emailBody = `🎉 NEW OVERNIGHT SLOTS AVAILABLE!\n\n`;
  emailBody += `📍 Equipment: ${TARGET_EQUIPMENT}\n\n`;
  emailBody += `📅 Check your "MakerSpace Availability" calendar\n\n`;

  emailBody += `🆕 NEW SLOTS:\n`;
  newSlots.forEach(slot => {
    emailBody += `   • ${formatDateWithDaysAway(slot.date)} at ${slot.time}\n`;
  });

  emailBody += `\n📋 ALL AVAILABLE SLOTS:\n`;
  allSlots.forEach(slot => {
    const daysAway = getDaysAway(slot.date);
    const clicks = getNextClickCount(daysAway);
    const clickText = formatClickCount(clicks);
    emailBody += `   • ${formatDateWithDaysAway(slot.date)} at ${slot.time}${clickText}\n`;
  });

  emailBody += `\n🔗 Book here: https://libcal.jocolibrary.org/reserve/makerspace\n`;
  emailBody += `\n⚡ Overnight slots fill fast - book now!\n`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: `🎉 ${TARGET_EQUIPMENT} Overnight Slots Available!`,
    text: emailBody
  };
  try {
    await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully');
  } catch (error) {
    console.error('❌ Error sending email:', error);
  }
}

async function checkAvailability() {
  await initializeCalendar();

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    console.log('Loading makerspace page...');
    await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.screenshot({ path: 'calendar-page1.png' });
    console.log('Screenshot saved to calendar-page1.png');

    await page.waitForSelector('a.fc-timeline-event', { timeout: 10000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const allAvailableSlots = [];
    let pageNum = 1;
    let hasNextPage = true;

    console.log('Starting to check all pages...');

    while (hasNextPage) {
      console.log(`Checking page ${pageNum}...`);

      const pageResults = await page.evaluate((equipmentName, ROW_HEIGHT, HOUR_WIDTH, DAY_WIDTH) => {
        // 1. Get equipment row labels with vertical position (dedup by top)
        const labelEls = Array.from(document.querySelectorAll('.fc-datagrid-cell-cushion .fc-cell-text'));
        const rowsByTop = new Map();
        labelEls.forEach(el => {
          const text = el.textContent.trim();
          if (!text || text === 'Info') return;
          const top = el.getBoundingClientRect().top;
          if (!rowsByTop.has(top)) rowsByTop.set(top, text);
        });

        // Find the target equipment's row top (there may be multiple rows
        // with the same equipment name - e.g. two 3D printers - so this
        // matches ALL rows with that name; we use the first match here,
        // consistent with original behavior of tracking one unit).
        let targetRowTop = null;
        for (const [top, text] of rowsByTop.entries()) {
          if (text === equipmentName) {
            targetRowTop = top;
            break;
          }
        }

        if (targetRowTop === null) {
          return { error: `Equipment "${equipmentName}" not found on this page`, availableSlots: [] };
        }

        // Events sit ~12px above their row's label top
        const EVENT_TOP_OFFSET = 12;
        const expectedEventTop = targetRowTop - EVENT_TOP_OFFSET;

        // 2. Get day headers (date + pixel range)
        const dayHeaderEls = Array.from(document.querySelectorAll('.fc-timeline-header *'))
          .filter(el => /\w+day,\s+\w+\s+\d{1,2},\s+\d{4}/.test(el.textContent) && el.children.length === 0);
        const dayHeaders = dayHeaderEls.map(el => {
          const parentTd = el.closest('td, th');
          const rect = (parentTd || el).getBoundingClientRect();
          return { text: el.textContent.trim(), left: rect.left, width: rect.width };
        });

        // 3. Get all events belonging to the target equipment's row
        const events = Array.from(document.querySelectorAll('a.fc-timeline-event'));
        const rowEvents = events.filter(e => {
          const top = e.getBoundingClientRect().top;
          return Math.abs(top - expectedEventTop) < ROW_HEIGHT / 2;
        });

        // 4. For each day, find the LAST (rightmost) event = last bookable hour
        const lastEventByDay = {}; // dayIndex -> event data
        rowEvents.forEach(e => {
          const rect = e.getBoundingClientRect();
          // Determine which day this event falls into
          const dayIdx = dayHeaders.findIndex(d => rect.left >= d.left && rect.left < d.left + d.width);
          if (dayIdx === -1) return;

          if (!lastEventByDay[dayIdx] || rect.left > lastEventByDay[dayIdx].left) {
            lastEventByDay[dayIdx] = {
              left: rect.left,
              className: e.className,
              dayIdx: dayIdx
            };
          }
        });

        // 5. Build available slots list
        const availableSlots = [];
        Object.values(lastEventByDay).forEach(ev => {
          const isAvailable = ev.className.includes('s-lc-eq-avail');
          if (!isAvailable) return;

          const dayHeader = dayHeaders[ev.dayIdx];
          const hourOffset = (ev.left - dayHeader.left) / HOUR_WIDTH;

          availableSlots.push({
            date: dayHeader.text,
            hourOffset: hourOffset
          });
        });

        return { availableSlots: availableSlots };
      }, TARGET_EQUIPMENT, ROW_HEIGHT, HOUR_WIDTH, DAY_WIDTH);

      if (pageResults.error) {
        console.log(`⚠️  ${pageResults.error}`);
      } else if (pageResults.availableSlots.length > 0) {
        pageResults.availableSlots.forEach(slot => {
          const timeStr = formatHourAsTimeString(slot.hourOffset);
          console.log(`  ✓ ${slot.date}: Last hour Available (${timeStr})`);
          allAvailableSlots.push({ date: slot.date, time: timeStr });
        });
      } else {
        console.log(`  No availability found on page ${pageNum}`);
      }

      const nextButton = await page.$('button.fc-next-button:not([disabled])');
      if (nextButton) {
        await nextButton.click();
        await new Promise(resolve => setTimeout(resolve, 2000));
        pageNum++;
      } else {
        hasNextPage = false;
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Total dates with available last hour: ${allAvailableSlots.length}`);
    if (allAvailableSlots.length > 0) {
      console.log('Available slots:', allAvailableSlots);
    }

    await updateGoogleCalendar(allAvailableSlots);

    const previousState = loadPreviousState();

    const newSlots = allAvailableSlots.filter(slot =>
      !previousState.availableSlots || !previousState.availableSlots.some(prevSlot =>
        prevSlot.date === slot.date && prevSlot.time === slot.time
      )
    );

    if (newSlots.length > 0) {
      console.log(`\n🆕 NEW availability detected for ${newSlots.length} slot(s)!`);
      console.log('New slots:', newSlots);

      await sendEmail(newSlots, allAvailableSlots);
    } else if (allAvailableSlots.length > 0) {
      console.log('\n✓ Availability unchanged (same slots as before)');
    } else {
      console.log('\n✗ No availability found');
    }

    savePreviousState({
      availableSlots: allAvailableSlots,
      lastChecked: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error checking availability:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

checkAvailability();
