const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const fs = require('fs');

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

async function sendEmail(availableSlots) {
  let emailBody = `🎉 NEW OVERNIGHT SLOTS AVAILABLE!\n\n`;
  emailBody += `📍 Equipment: ${TARGET_EQUIPMENT}\n\n`;
  emailBody += `📅 AVAILABLE DATES (Last Bookable Hour):\n`;
  
  availableSlots.forEach(slot => {
    emailBody += `   • ${formatDateWithDaysAway(slot.date)} at ${slot.time}\n`;
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
        
        const availableSlots = [];
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
              availableSlots.push({ date: date, time: lastSlot.time });
            } else {
              console.log(`  ✗ ${equipmentName} - ${date}: Last hour Reserved`);
            }
          }
        });
        
        console.log(`Monitoring: ${equipmentName}`);
        console.log('All equipment found on page (first 10):', Array.from(allEquipment).slice(0, 10));
        
        return {
          availableSlots: availableSlots,
          allEquipment: Array.from(allEquipment)
        };
      }, TARGET_EQUIPMENT);
      
      console.log(`Page ${pageNum} results:`, pageResults);
      allAvailableSlots.push(...pageResults.availableSlots);
      
      // Check if there's a next page button
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
    
    // Load previous state
    const previousState = loadPreviousState();
    
    // Check for new availability
    const newSlots = allAvailableSlots.filter(slot => 
      !previousState.availableSlots || !previousState.availableSlots.some(prevSlot => 
        prevSlot.date === slot.date && prevSlot.time === slot.time
      )
    );
    
    if (newSlots.length > 0) {
      console.log(`\n🆕 NEW availability detected for ${newSlots.length} slot(s)!`);
      console.log('New slots:', newSlots);
      
      // Send email notification
      await sendEmail(newSlots);
    } else if (allAvailableSlots.length > 0) {
      console.log('\n✓ Availability unchanged (same slots as before)');
    } else {
      console.log('\n✗ No availability found');
    }
    
    // Save current state
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

// Run the main function
checkAvailability();
