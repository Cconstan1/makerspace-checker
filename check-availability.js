const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const nodemailer = require('nodemailer');

const EQUIPMENT_TO_MONITOR = [
  '3D Printer - Prusa XL 5-Toolhead'
];const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const nodemailer = require('nodemailer');

const EQUIPMENT_TO_MONITOR = [
  'Soldering Iron & Electronics Rework Station',
  'Vinyl Cutter & Heat Press w/PC',
  'Resin Printer -Formlabs Form 3 & Dell PC'
];

const STATE_FILE = 'previous-state.json';

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function getDaysAway(dateString) {
  const targetDate = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  targetDate.setHours(0, 0, 0, 0);
  
  const diffTime = targetDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'TODAY';
  if (diffDays === 1) return 'tomorrow (1 day away)';
  return `${diffDays} days away`;
}

function getCalendarUrl(dateString) {
  // Parse the date to get the calendar page URL
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `https://libcal.jocolibrary.org/reserve/makerspace?date=${year}-${month}-${day}`;
}

async function sendEmailNotification(newAvailability, isFirstRun) {
  const emailTo = process.env.EMAIL_TO;
  
  if (!emailTo) {
    console.log('⚠️ EMAIL_TO not configured - skipping email');
    return;
  }

  // Build email content
  let subject = isFirstRun 
    ? '🎉 MakerSpace Availability Checker Started'
    : `🎉 NEW MakerSpace Equipment Available! (${newAvailability.length} slot${newAvailability.length > 1 ? 's' : ''})`;

  let body = isFirstRun
    ? 'MakerSpace availability checker is now running!\n\nCurrently available overnight printing slots:\n\n'
    : 'NEW availability detected for overnight printing slots:\n\n';

  // Group by date for better readability
  const byDate = {};
  newAvailability.forEach(slot => {
    if (!byDate[slot.date]) {
      byDate[slot.date] = [];
    }
    byDate[slot.date].push(slot.equipment);
  });

  // Sort dates chronologically
  const sortedDates = Object.keys(byDate).sort((a, b) => {
    return new Date(a) - new Date(b);
  });

  // Find the earliest date for the direct booking link
  const earliestDate = sortedDates.length > 0 ? sortedDates[0] : null;
  const bookingUrl = earliestDate 
    ? getCalendarUrl(earliestDate)
    : 'https://libcal.jocolibrary.org/reserve/makerspace';

  sortedDates.forEach(date => {
    const daysAway = getDaysAway(date);
    body += `📅 ${date} (${daysAway})\n`;
    byDate[date].forEach(equipment => {
      body += `   • ${equipment}\n`;
    });
    body += '\n';
  });

  if (earliestDate) {
    body += `\n🔗 Book the earliest date (${earliestDate}): ${bookingUrl}\n`;
  } else {
    body += `\n🔗 Book now: ${bookingUrl}\n`;
  }
  
  body += `\n---\n`;
  body += `This checker runs every 10 minutes monitoring overnight slots for:\n`;
  EQUIPMENT_TO_MONITOR.forEach(eq => {
    body += `  • ${eq}\n`;
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: emailTo,
    subject: subject,
    text: body
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${emailTo}`);
  } catch (error) {
    console.error('❌ Failed to send email:', error.message);
    throw error;
  }
}

async function checkAvailability() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    
    console.log('Loading makerspace page...');
    await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await page.screenshot({ path: 'calendar-page1.png' });
    console.log('Screenshot saved to calendar-page1.png');

    let allAvailableDates = [];
    let pageNum = 1;

    console.log('Starting to check all pages...');

    while (true) {
      console.log(`Checking page ${pageNum}...`);

      const availableOnPage = await page.evaluate((equipmentList) => {
        console.log('=== Starting page evaluation ===');
        
        const slots = document.querySelectorAll('a.fc-timeline-event');
        console.log(`Found ${slots.length} total event slots`);
        
        const available = [];
        const equipmentRows = {};
        const foundEquipment = new Set();

        slots.forEach(slot => {
          const title = slot.getAttribute('title') || '';
          const ariaLabel = slot.getAttribute('aria-label') || '';
          
          const equipmentMatch = title.match(/^(.+?)\s+Reserved/) || title.match(/^(.+?)\s+Available/);
          if (!equipmentMatch) return;
          
          const equipment = equipmentMatch[1].trim();
          foundEquipment.add(equipment);
          
          if (!equipmentList.includes(equipment)) return;

          const dateMatch = ariaLabel.match(/(\w+day,\s+\w+\s+\d+,\s+\d{4})/);
          if (!dateMatch) return;
          
          const eventDate = dateMatch[1];
          const timeMatch = ariaLabel.match(/(\d{1,2}:\d{2}(?:am|pm))/);
          const eventTime = timeMatch ? timeMatch[1] : '';

          if (!equipmentRows[equipment]) {
            equipmentRows[equipment] = {};
          }
          if (!equipmentRows[equipment][eventDate]) {
            equipmentRows[equipment][eventDate] = [];
          }

          equipmentRows[equipment][eventDate].push({
            time: eventTime,
            isAvailable: title.includes('Available')
          });
        });

        Object.keys(equipmentRows).forEach(equipment => {
          Object.keys(equipmentRows[equipment]).forEach(date => {
            const events = equipmentRows[equipment][date];
            events.sort((a, b) => {
              const timeToMinutes = (t) => {
                const match = t.match(/(\d{1,2}):(\d{2})(am|pm)/);
                if (!match) return 0;
                let hours = parseInt(match[1]);
                const minutes = parseInt(match[2]);
                const isPM = match[3] === 'pm';
                if (isPM && hours !== 12) hours += 12;
                if (!isPM && hours === 12) hours = 0;
                return hours * 60 + minutes;
              };
              return timeToMinutes(b.time) - timeToMinutes(a.time);
            });

            const lastEvent = events[0];
            const status = lastEvent.isAvailable ? 'AVAILABLE' : 'Reserved';
            const symbol = lastEvent.isAvailable ? '✓' : '✗';
            
            console.log(`  ${symbol} ${equipment} - ${date}: Last hour ${status}`);

            if (lastEvent.isAvailable) {
              available.push({
                equipment: equipment,
                date: date,
                dateTime: `${lastEvent.time} ${date}`
              });
            }
          });
        });

        console.log('All equipment found on this page:', Array.from(foundEquipment));
        console.log(`=== Page evaluation complete. Found ${available.length} last-hour available slots ===`);
        return available;
      }, EQUIPMENT_TO_MONITOR);

      console.log(`Page ${pageNum} found:`, availableOnPage);
      allAvailableDates.push(...availableOnPage);

      const hasNextButton = await page.evaluate(() => {
        const nextButton = document.querySelector('button.fc-next-button');
        return nextButton && !nextButton.disabled;
      });

      if (!hasNextButton) {
        console.log('Next button is disabled - reached end of calendar');
        break;
      }

      await page.click('button.fc-next-button');
      console.log('Clicked next button');
      await new Promise(resolve => setTimeout(resolve, 3000));
      pageNum++;
    }

    // Sort by date
    allAvailableDates.sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });

    console.log('Total available dates found:', allAvailableDates);

    // Load previous state
    let previousState = [];
    let isFirstRun = false;
    
    try {
      const data = await fs.readFile(STATE_FILE, 'utf8');
      previousState = JSON.parse(data);
    } catch (error) {
      console.log('No previous state found (first run)');
      isFirstRun = true;
    }

    // Compare states - find NEW availability
    const previousKeys = new Set(
      previousState.map(item => `${item.equipment}-${item.date}`)
    );
    
    const currentAvailable = allAvailableDates;
    const newAvailability = currentAvailable.filter(current => {
      const key = `${current.equipment}-${current.date}`;
      return !previousKeys.has(key);
    });

    const hasNewAvailability = newAvailability.length > 0;

    if (hasNewAvailability) {
      console.log('New availability detected:', newAvailability);
    } else if (!isFirstRun) {
      console.log('No new availability detected');
    }

    // Send email if there's new availability or first run
    if (hasNewAvailability || isFirstRun) {
      await sendEmailNotification(newAvailability, isFirstRun);
    } else {
      console.log('📧 No new availability - no email sent');
    }

    // Save current state
    await fs.writeFile(STATE_FILE, JSON.stringify(allAvailableDates, null, 2));
    console.log('Saved current state');

    // Format output for GitHub Actions summary
    console.log('\n🖨️ 3D PRINTER AVAILABILITY CHECK');
    console.log('================================\n');
    
    if (allAvailableDates.length === 0) {
      console.log('❌ No overnight slots currently available\n');
    } else {
      console.log('✅ Currently Available\n');
      
      const byDate = {};
      allAvailableDates.forEach(slot => {
        if (!byDate[slot.date]) {
          byDate[slot.date] = [];
        }
        byDate[slot.date].push(slot.equipment);
      });

      Object.keys(byDate).forEach(date => {
        console.log(`  • ${date}:`);
        byDate[date].forEach(equipment => {
          console.log(`    - ${equipment}`);
        });
        console.log('');
      });
    }

    console.log('Book now at: https://libcal.jocolibrary.org/reserve/makerspace');

  } finally {
    await browser.close();
  }
}

checkAvailability().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

const STATE_FILE = 'previous-state.json';

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function getDaysAway(dateString) {
  const targetDate = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  targetDate.setHours(0, 0, 0, 0);
  
  const diffTime = targetDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'TODAY';
  if (diffDays === 1) return 'tomorrow (1 day away)';
  return `${diffDays} days away`;
}

function getCalendarUrl(dateString) {
  // Parse the date to get the calendar page URL
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `https://libcal.jocolibrary.org/reserve/makerspace?date=${year}-${month}-${day}`;
}

async function sendEmailNotification(newAvailability, isFirstRun) {
  const emailTo = process.env.EMAIL_TO;
  
  if (!emailTo) {
    console.log('⚠️ EMAIL_TO not configured - skipping email');
    return;
  }

  // Build email content
  let subject = isFirstRun 
    ? '🎉 MakerSpace Availability Checker Started'
    : `🎉 NEW MakerSpace Equipment Available! (${newAvailability.length} slot${newAvailability.length > 1 ? 's' : ''})`;

  let body = isFirstRun
    ? 'MakerSpace availability checker is now running!\n\nCurrently available overnight printing slots:\n\n'
    : 'NEW availability detected for overnight printing slots:\n\n';

  // Group by date for better readability
  const byDate = {};
  newAvailability.forEach(slot => {
    if (!byDate[slot.date]) {
      byDate[slot.date] = [];
    }
    byDate[slot.date].push(slot.equipment);
  });

  // Sort dates chronologically
  const sortedDates = Object.keys(byDate).sort((a, b) => {
    return new Date(a) - new Date(b);
  });

  // Find the earliest date for the direct booking link
  const earliestDate = sortedDates.length > 0 ? sortedDates[0] : null;
  const bookingUrl = earliestDate 
    ? getCalendarUrl(earliestDate)
    : 'https://libcal.jocolibrary.org/reserve/makerspace';

  sortedDates.forEach(date => {
    const daysAway = getDaysAway(date);
    body += `📅 ${date} (${daysAway})\n`;
    byDate[date].forEach(equipment => {
      body += `   • ${equipment}\n`;
    });
    body += '\n';
  });

  if (earliestDate) {
    body += `\n🔗 Book the earliest date (${earliestDate}): ${bookingUrl}\n`;
  } else {
    body += `\n🔗 Book now: ${bookingUrl}\n`;
  }
  
  body += `\n---\n`;
  body += `This checker runs every 10 minutes monitoring overnight slots for:\n`;
  EQUIPMENT_TO_MONITOR.forEach(eq => {
    body += `  • ${eq}\n`;
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: emailTo,
    subject: subject,
    text: body
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${emailTo}`);
  } catch (error) {
    console.error('❌ Failed to send email:', error.message);
    throw error;
  }
}

async function checkAvailability() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    
    console.log('Loading makerspace page...');
    await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await page.screenshot({ path: 'calendar-page1.png' });
    console.log('Screenshot saved to calendar-page1.png');

    let allAvailableDates = [];
    let pageNum = 1;

    console.log('Starting to check all pages...');

    while (true) {
      console.log(`Checking page ${pageNum}...`);

      const availableOnPage = await page.evaluate((equipmentList) => {
        console.log('=== Starting page evaluation ===');
        
        const slots = document.querySelectorAll('a.fc-timeline-event');
        console.log(`Found ${slots.length} total event slots`);
        
        const available = [];
        const equipmentRows = {};

        slots.forEach(slot => {
          const title = slot.getAttribute('title') || '';
          const ariaLabel = slot.getAttribute('aria-label') || '';
          
          const equipmentMatch = title.match(/^(.+?)\s+Reserved/) || title.match(/^(.+?)\s+Available/);
          if (!equipmentMatch) return;
          
          const equipment = equipmentMatch[1].trim();
          if (!equipmentList.includes(equipment)) return;

          const dateMatch = ariaLabel.match(/(\w+day,\s+\w+\s+\d+,\s+\d{4})/);
          if (!dateMatch) return;
          
          const eventDate = dateMatch[1];
          const timeMatch = ariaLabel.match(/(\d{1,2}:\d{2}(?:am|pm))/);
          const eventTime = timeMatch ? timeMatch[1] : '';

          if (!equipmentRows[equipment]) {
            equipmentRows[equipment] = {};
          }
          if (!equipmentRows[equipment][eventDate]) {
            equipmentRows[equipment][eventDate] = [];
          }

          equipmentRows[equipment][eventDate].push({
            time: eventTime,
            isAvailable: title.includes('Available')
          });
        });

        Object.keys(equipmentRows).forEach(equipment => {
          Object.keys(equipmentRows[equipment]).forEach(date => {
            const events = equipmentRows[equipment][date];
            events.sort((a, b) => {
              const timeToMinutes = (t) => {
                const match = t.match(/(\d{1,2}):(\d{2})(am|pm)/);
                if (!match) return 0;
                let hours = parseInt(match[1]);
                const minutes = parseInt(match[2]);
                const isPM = match[3] === 'pm';
                if (isPM && hours !== 12) hours += 12;
                if (!isPM && hours === 12) hours = 0;
                return hours * 60 + minutes;
              };
              return timeToMinutes(b.time) - timeToMinutes(a.time);
            });

            const lastEvent = events[0];
            const status = lastEvent.isAvailable ? 'AVAILABLE' : 'Reserved';
            const symbol = lastEvent.isAvailable ? '✓' : '✗';
            
            console.log(`  ${symbol} ${equipment} - ${date}: Last hour ${status}`);

            if (lastEvent.isAvailable) {
              available.push({
                equipment: equipment,
                date: date,
                dateTime: `${lastEvent.time} ${date}`
              });
            }
          });
        });

        console.log(`=== Page evaluation complete. Found ${available.length} last-hour available slots ===`);
        return available;
      }, EQUIPMENT_TO_MONITOR);

      console.log(`Page ${pageNum} found:`, availableOnPage);
      allAvailableDates.push(...availableOnPage);

      const hasNextButton = await page.evaluate(() => {
        const nextButton = document.querySelector('button.fc-next-button');
        return nextButton && !nextButton.disabled;
      });

      if (!hasNextButton) {
        console.log('Next button is disabled - reached end of calendar');
        break;
      }

      await page.click('button.fc-next-button');
      console.log('Clicked next button');
      await new Promise(resolve => setTimeout(resolve, 3000));
      pageNum++;
    }

    // Sort by date
    allAvailableDates.sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });

    console.log('Total available dates found:', allAvailableDates);

    // Load previous state
    let previousState = [];
    let isFirstRun = false;
    
    try {
      const data = await fs.readFile(STATE_FILE, 'utf8');
      previousState = JSON.parse(data);
    } catch (error) {
      console.log('No previous state found (first run)');
      isFirstRun = true;
    }

    // Compare states - find NEW availability
    const previousKeys = new Set(
      previousState.map(item => `${item.equipment}-${item.date}`)
    );
    
    const currentAvailable = allAvailableDates;
    const newAvailability = currentAvailable.filter(current => {
      const key = `${current.equipment}-${current.date}`;
      return !previousKeys.has(key);
    });

    const hasNewAvailability = newAvailability.length > 0;

    if (hasNewAvailability) {
      console.log('New availability detected:', newAvailability);
    } else if (!isFirstRun) {
      console.log('No new availability detected');
    }

    // Send email if there's new availability or first run
    if (hasNewAvailability || isFirstRun) {
      await sendEmailNotification(newAvailability, isFirstRun);
    } else {
      console.log('📧 No new availability - no email sent');
    }

    // Save current state
    await fs.writeFile(STATE_FILE, JSON.stringify(allAvailableDates, null, 2));
    console.log('Saved current state');

    // Format output for GitHub Actions summary
    console.log('\n🖨️ 3D PRINTER AVAILABILITY CHECK');
    console.log('================================\n');
    
    if (allAvailableDates.length === 0) {
      console.log('❌ No overnight slots currently available\n');
    } else {
      console.log('✅ Currently Available\n');
      
      const byDate = {};
      allAvailableDates.forEach(slot => {
        if (!byDate[slot.date]) {
          byDate[slot.date] = [];
        }
        byDate[slot.date].push(slot.equipment);
      });

      Object.keys(byDate).forEach(date => {
        console.log(`  • ${date}:`);
        byDate[date].forEach(equipment => {
          console.log(`    - ${equipment}`);
        });
        console.log('');
      });
    }

    console.log('Book now at: https://libcal.jocolibrary.org/reserve/makerspace');

  } finally {
    await browser.close();
  }
}

checkAvailability().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
