const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const fs = require('fs');

const TARGET_EQUIPMENT = '3D Printer - Prusa XL 5-Toolhead';
const STATE_FILE = 'previous-state.json';

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function loadPreviousState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading previous state:', error);
  }
  return { availableDates: [], lastChecked: null };
}

function savePreviousState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('Saved current state');
  } catch (error) {
    console.error('Error saving state:', error);
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

async function navigateToBookingForm(page, targetDate) {
  try {
    console.log(`\n🎯 Attempting to navigate to booking form for ${targetDate}...`);
    
    // Go back to the main calendar page
    await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    console.log('Loaded calendar page');
    
    // Wait for calendar to be ready
    await page.waitForSelector('a.fc-timeline-event', { timeout: 10000 });
    await page.waitForTimeout(2000);
    
    // Navigate to the correct date by clicking Next
    const targetDateObj = new Date(targetDate);
    let foundDate = false;
    let clickCount = 0;
    const maxClicks = 10;
    
    while (!foundDate && clickCount < maxClicks) {
      // Check current page date range
      const currentDateRange = await page.evaluate(() => {
        const events = Array.from(document.querySelectorAll('a.fc-timeline-event'));
        if (events.length === 0) return null;
        
        const dates = events.map(event => {
          const title = event.getAttribute('title') || '';
          const match = title.match(/(\w+day, \w+ \d+, \d{4})/);
          return match ? new Date(match[1]) : null;
        }).filter(d => d !== null);
        
        if (dates.length === 0) return null;
        return {
          min: Math.min(...dates.map(d => d.getTime())),
          max: Math.max(...dates.map(d => d.getTime()))
        };
      });
      
      if (!currentDateRange) {
        console.log('Could not determine current date range');
        break;
      }
      
      const targetTime = targetDateObj.getTime();
      
      // Check if target date is in current view
      if (targetTime >= currentDateRange.min && targetTime <= currentDateRange.max) {
        console.log(`Found target date on page (after ${clickCount} clicks)`);
        foundDate = true;
        break;
      }
      
      // Click Next button
      const nextButton = await page.$('button.fc-next-button:not([disabled])');
      if (!nextButton) {
        console.log('Next button not found or disabled');
        break;
      }
      
      await nextButton.click();
      console.log(`Clicked Next button (${clickCount + 1})`);
      await page.waitForTimeout(3000); // Wait for page to load
      clickCount++;
    }
    
    if (!foundDate) {
      console.log('❌ Could not navigate to target date');
      return null;
    }
    
    // Now find and click the specific slot
    console.log('Looking for the available slot...');
    
    const slotClicked = await page.evaluate((equipmentName, targetDateStr) => {
      const events = Array.from(document.querySelectorAll('a.fc-timeline-event'));
      
      for (const event of events) {
        const title = event.getAttribute('title') || '';
        
        // Extract date
        const dateMatch = title.match(/(\w+day, \w+ \d+, \d{4})/);
        if (!dateMatch) continue;
        const eventDateStr = dateMatch[1];
        
        // Extract equipment name
        const equipMatch = title.match(/\d{4}\s+-\s+(.+?)\s+-\s+(?:Reserved|Available)/);
        if (!equipMatch) continue;
        const eventEquipment = equipMatch[1];
        
        // Check if Available
        const isAvailable = title.includes('- Available');
        
        // Match our target
        if (eventEquipment === equipmentName && 
            eventDateStr === targetDateStr && 
            isAvailable) {
          console.log(`Found matching slot: ${title}`);
          event.click();
          return true;
        }
      }
      return false;
    }, TARGET_EQUIPMENT, targetDateObj.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    }));
    
    if (!slotClicked) {
      console.log('❌ Could not find the available slot to click');
      return null;
    }
    
    console.log('✅ Clicked the available slot');
    await page.waitForTimeout(2000);
    
    // Click "Submit Times" button
    console.log('Looking for Submit Times button...');
    await page.waitForSelector('button:has-text("Submit Times"), input[value="Submit Times"]', { timeout: 5000 });
    
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const submitButton = buttons.find(btn => 
        btn.textContent.includes('Submit Times') || 
        btn.value === 'Submit Times'
      );
      if (submitButton) submitButton.click();
    });
    
    console.log('✅ Clicked Submit Times');
    await page.waitForTimeout(3000);
    
    // Click "Continue" button on terms page
    console.log('Looking for Continue button...');
    await page.waitForSelector('button:has-text("Continue"), input[value="Continue"], a:has-text("Continue")', { timeout: 5000 });
    
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      const continueButton = elements.find(el => 
        el.textContent.includes('Continue') || 
        el.value === 'Continue'
      );
      if (continueButton) continueButton.click();
    });
    
    console.log('✅ Clicked Continue');
    await page.waitForTimeout(3000);
    
    // Get the final booking form URL
    const bookingFormUrl = page.url();
    console.log(`\n🎉 Successfully navigated to booking form!`);
    console.log(`📋 Booking form URL: ${bookingFormUrl}`);
    
    // Take a screenshot of the booking form
    await page.screenshot({ path: 'booking-form.png', fullPage: true });
    console.log('📸 Screenshot saved: booking-form.png');
    
    return bookingFormUrl;
    
  } catch (error) {
    console.error('❌ Error navigating to booking form:', error.message);
    return null;
  }
}

async function sendEmail(availableDates, bookingFormUrl) {
  const earliestDate = availableDates[0];
  
  let emailBody = `🎉 3D PRINTER OVERNIGHT SLOTS NOW AVAILABLE!\n\n`;
  
  if (bookingFormUrl) {
    emailBody += `📋 DIRECT BOOKING LINK:\n`;
    emailBody += `Click here to book: ${bookingFormUrl}\n\n`;
    emailBody += `✨ The slot is already selected! Just fill in your name and email, then click "Submit my Booking"\n\n`;
  } else {
    emailBody += `⚠️ Auto-navigation failed. Please book manually:\n`;
    emailBody += `🔗 https://libcal.jocolibrary.org/reserve/makerspace\n\n`;
    emailBody += `📍 MANUAL BOOKING INSTRUCTIONS:\n`;
    const daysAway = getDaysAway(earliestDate);
    const nextClicks = Math.ceil(daysAway / 3);
    emailBody += `   1. Click the link above\n`;
    emailBody += `   2. Click "Next >" button ${nextClicks} times to reach ${earliestDate}\n`;
    emailBody += `   3. Scroll to "3D Printer - Prusa XL 5-Toolhead"\n`;
    emailBody += `   4. Click the green slot at 6:00pm or 7:00pm (last hour)\n`;
    emailBody += `   5. Click "Submit Times" then "Continue"\n`;
    emailBody += `   6. Fill in your info and submit\n\n`;
  }
  
  emailBody += `📅 AVAILABLE DATES:\n`;
  availableDates.forEach(date => {
    emailBody += `   • ${formatDateWithDaysAway(date)}\n`;
  });
  
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
    await page.waitForTimeout(2000);

    const allAvailableDates = [];
    let pageNum = 1;
    let hasNextPage = true;

    console.log('Starting to check all pages...');

    while (hasNextPage) {
      console.log(`Checking page ${pageNum}...`);

      const pageResults = await page.evaluate((equipmentName) => {
        console.log('=== Starting page evaluation ===');
        
        const events = Array.from(document.querySelectorAll('a.fc-timeline-event'));
        console.log(`Found ${events.length} total event slots`);

        const equipmentByDate = {};
        const allEquipment = new Set();

        events.forEach(event => {
          const title = event.getAttribute('title') || '';
          
          const timeMatch = title.match(/^(\d{1,2}:\d{2}[ap]m)/);
          if (!timeMatch) return;
          const timeStr = timeMatch[1];

          const dateMatch = title.match(/(\w+day, \w+ \d+, \d{4})/);
          if (!dateMatch) return;
          const dateStr = dateMatch[1];

          const equipMatch = title.match(/\d{4}\s+-\s+(.+?)\s+-\s+(?:Reserved|Available)/);
          if (!equipMatch) return;
          const equipment = equipMatch[1];
          
          allEquipment.add(equipment);

          const isAvailable = title.includes('- Available');

          if (!equipmentByDate[dateStr]) {
            equipmentByDate[dateStr] = {};
          }
          if (!equipmentByDate[dateStr][equipment]) {
            equipmentByDate[dateStr][equipment] = [];
          }

          equipmentByDate[dateStr][equipment].push({
            time: timeStr,
            available: isAvailable
          });
        });

        const availableDates = [];

        Object.keys(equipmentByDate).forEach(date => {
          if (equipmentByDate[date][equipmentName]) {
            const slots = equipmentByDate[date][equipmentName];
            
            slots.sort((a, b) => {
              const parseTime = (timeStr) => {
                const [time, period] = timeStr.match(/(\d{1,2}:\d{2})([ap]m)/).slice(1);
                let [hours, minutes] = time.split(':').map(Number);
                if (period === 'pm' && hours !== 12) hours += 12;
                if (period === 'am' && hours === 12) hours = 0;
                return hours * 60 + minutes;
              };
              return parseTime(b.time) - parseTime(a.time);
            });

            const lastSlot = slots[0];
            
            if (lastSlot.available) {
              console.log(`  ✓ ${equipmentName} - ${date}: Last hour Available (${lastSlot.time})`);
              availableDates.push(date);
            } else {
              console.log(`  ✗ ${equipmentName} - ${date}: Last hour Reserved`);
            }
          }
        });

        console.log(`Monitoring: ${equipmentName}`);
        console.log(`All equipment found on page (first 10):`, Array.from(allEquipment).slice(0, 10));
        console.log(`3D Printer in list: ${allEquipment.has(equipmentName)}`);
        console.log(`=== Page evaluation complete. Found ${availableDates.length} last-hour available slots ===`);

        return availableDates;
      }, TARGET_EQUIPMENT);

      console.log(`Page ${pageNum} found:`, pageResults);
      allAvailableDates.push(...pageResults);

      const nextButtonDisabled = await page.evaluate(() => {
        const nextButton = document.querySelector('button.fc-next-button');
        return !nextButton || nextButton.disabled;
      });

      if (nextButtonDisabled) {
        console.log('Next button is disabled - reached end of calendar');
        hasNextPage = false;
      } else {
        await page.click('button.fc-next-button');
        console.log('Clicked next button');
        await page.waitForTimeout(3000);
        pageNum++;
      }
    }

    console.log('Total available dates found:', allAvailableDates);

    const previousState = loadPreviousState();
    const previousDates = new Set(previousState.availableDates || []);
    const currentDates = new Set(allAvailableDates);

    const newDates = allAvailableDates.filter(date => !previousDates.has(date));
    const isFirstRun = previousState.lastChecked === null;

    let bookingFormUrl = null;

    if (newDates.length > 0 || isFirstRun) {
      console.log(isFirstRun ? '📧 First run - sending current state email' : '📧 New availability detected!');
      
      if (allAvailableDates.length > 0) {
        // Sort dates and get earliest
        const sortedDates = [...allAvailableDates].sort((a, b) => new Date(a) - new Date(b));
        const earliestDate = sortedDates[0];
        
        // Attempt to navigate to booking form
        bookingFormUrl = await navigateToBookingForm(page, earliestDate);
      }
      
      await sendEmail(allAvailableDates, bookingFormUrl);
    } else {
      console.log('No new availability detected');
      console.log('📧 No new availability - no email sent');
    }

    savePreviousState({
      availableDates: allAvailableDates,
      lastChecked: new Date().toISOString()
    });

    console.log('\n🖨️ 3D PRINTER AVAILABILITY CHECK');
    console.log('================================\n');
    
    if (allAvailableDates.length > 0) {
      console.log('✅ Overnight slots available:');
      allAvailableDates.forEach(date => {
        console.log(`   • ${formatDateWithDaysAway(date)}`);
      });
      if (bookingFormUrl) {
        console.log(`\n📋 Direct booking form: ${bookingFormUrl}`);
      }
    } else {
      console.log('❌ No overnight slots currently available');
    }
    
    console.log('\nBook now at: https://libcal.jocolibrary.org/reserve/makerspace');

  } catch (error) {
    console.error('Error during check:', error);
  } finally {
    await browser.close();
  }
}

checkAvailability();
