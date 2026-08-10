const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const { google } = require('googleapis');

const TARGET_EQUIPMENT = '3D Printer - Prusa XL 5-Toolhead'; // CHECK EQUIPMENT NAME
const STATE_FILE = 'previous-state.json';

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
    subject: '🎉 3D Printer Overnight Slots Available!',
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

      // DEBUG BUILD v4 - ancestor attribute inspection (looking for data-date)
      const pageResults = await page.evaluate((equipmentName) => {
        const labelEls = Array.from(document.querySelectorAll('.fc-datagrid-cell-cushion .fc-cell-text, .fc-datagrid-cell-cushion a'));
        const rowLabels = labelEls.map(el => {
          const rect = el.getBoundingClientRect();
          return { text: el.textContent.trim(), top: rect.top, height: rect.height };
        }).filter(r => r.text.length > 0);

        const events = Array.from(document.querySelectorAll('a.fc-timeline-event'));

        const eventSamples = events.slice(0, 5).map(e => {
          const rect = e.getBoundingClientRect();

          // Walk up the ancestor chain looking for date info (common
          // FullCalendar pattern: data-date lives on a wrapping <td>).
          const ancestors = [];
          let node = e.parentElement;
          for (let i = 0; i < 6 && node; i++) {
            const attrs = {};
            for (const attr of node.attributes) {
              attrs[attr.name] = attr.value;
            }
            ancestors.push({ tag: node.tagName, attrs: attrs });
            node = node.parentElement;
          }

          return {
            className: e.className,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            ancestors: ancestors
          };
        });

        return {
          totalEventsFound: events.length,
          rowLabelCount: rowLabels.length,
          rowLabels: rowLabels.slice(0, 20),
          eventSamples: eventSamples
        };
      }, TARGET_EQUIPMENT);

      console.log(`Page ${pageNum} results:`, JSON.stringify(pageResults, null, 2));
      // allAvailableSlots stays empty for this debug pass

      const nextButton = await page.$('button.fc-next-button:not([disabled])');
      if (nextButton) {
        console.log('Clicking next page...');
        await nextButton.click();
        await new Promise(resolve => setTimeout(resolve, 2000));
        pageNum++;
      } else {
        console.log('No more pages to check');
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
