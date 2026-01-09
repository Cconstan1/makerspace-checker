const puppeteer = require('puppeteer');

// Helper function to wait/delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkAvailability() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        console.log('Loading makerspace page...');
        await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Capture browser console logs
        page.on('console', msg => {
            console.log('BROWSER:', msg.text());
        });
        
        // Wait for the calendar to load
        await page.waitForSelector('table', { timeout: 10000 });
        await delay(3000); // Extra wait for dynamic content
        
        // Take a screenshot to see what we're working with
        await page.screenshot({ path: 'calendar-page1.png', fullPage: true });
        console.log('Screenshot saved to calendar-page1.png');
        
        console.log('Starting to check all pages...');
        
        const allAvailableDates = [];
        let pageNumber = 1;
        
        while (true) {
            console.log(`Checking page ${pageNumber}...`);
            
            // Extract availability from current page
            const availableDates = await page.evaluate(() => {
                const results = [];
                
                console.log('=== Starting page evaluation ===');
                
                // Find ALL event slots (both available and reserved)
                const allEvents = document.querySelectorAll('a.fc-timeline-event');
                console.log(`Found ${allEvents.length} total event slots`);
                
                // Group by date and equipment to find the LAST bookable slot
                const dateEquipmentSlots = {};
                
                allEvents.forEach(event => {
                    const title = event.getAttribute('title') || event.getAttribute('aria-label') || '';
                    
                    // Extract equipment name and date/time from title
                    // Format: "7:00pm Tuesday, January 13, 2026 - Equipment Name - Status"
                    const match = title.match(/(.+?) - (.+?) - (Available|Reserved)/);
                    
                    if (match) {
                        const dateTimeStr = match[1].trim();
                        const equipmentName = match[2].trim();
                        const status = match[3].trim();
                        
                        // Check if this is one of our target equipment
                        const isTargetEquipment = equipmentName.includes('Soldering Iron & Electronics Rework Station') || 
                                                 equipmentName.includes('Vinyl Cutter & Heat Press w/PC') ||
                                                 equipmentName.includes('Resin Printer -Formlabs Form 3 & Dell PC');
                        
                        if (isTargetEquipment) {
                            // Extract just the date (everything after the time)
                            const dateMatch = dateTimeStr.match(/\d{1,2}:\d{2}[ap]m\s+(.+)/);
                            const dateStr = dateMatch ? dateMatch[1] : dateTimeStr;
                            
                            // Extract time for comparison (convert to 24hr for sorting)
                            const timeMatch = dateTimeStr.match(/(\d{1,2}):(\d{2})([ap]m)/);
                            let timeValue = 0;
                            if (timeMatch) {
                                let hour = parseInt(timeMatch[1]);
                                const minute = parseInt(timeMatch[2]);
                                const ampm = timeMatch[3];
                                if (ampm === 'pm' && hour !== 12) hour += 12;
                                if (ampm === 'am' && hour === 12) hour = 0;
                                timeValue = hour * 60 + minute;
                            }
                            
                            const key = `${dateStr}|${equipmentName}`;
                            
                            // Keep the LATEST time slot for this date+equipment combo
                            if (!dateEquipmentSlots[key] || timeValue > dateEquipmentSlots[key].timeValue) {
                                dateEquipmentSlots[key] = {
                                    equipment: equipmentName,
                                    date: dateStr,
                                    dateTime: dateTimeStr,
                                    timeValue: timeValue,
                                    status: status
                                };
                            }
                        }
                    }
                });
                
                // Filter to only include slots where the LAST hour is Available
                Object.values(dateEquipmentSlots).forEach(slot => {
                    if (slot.status === 'Available') {
                        results.push({
                            equipment: slot.equipment,
                            date: slot.date,
                            dateTime: slot.dateTime
                        });
                        console.log(`  ✓ ${slot.equipment} - ${slot.date}: Last hour AVAILABLE`);
                    } else {
                        console.log(`  ✗ ${slot.equipment} - ${slot.date}: Last hour ${slot.status}`);
                    }
                });
                
                console.log(`=== Page evaluation complete. Found ${results.length} last-hour available slots ===`);
                return results;
            });
            
            console.log(`Page ${pageNumber} found:`, availableDates);
            allAvailableDates.push(...availableDates);
            
            // Check if next button is disabled (this is the real indicator we're at the end)
            const nextButtonDisabled = await page.evaluate(() => {
                const nextBtn = document.querySelector('button.fc-next-button');
                return nextBtn ? nextBtn.disabled : true;
            });
            
            if (nextButtonDisabled) {
                console.log('Next button is disabled - reached end of calendar');
                break;
            }
            
            // Try to click the next button
            try {
                await page.waitForSelector('button.fc-next-button', { timeout: 5000 });
                await page.click('button.fc-next-button');
                console.log('Clicked next button');
                await delay(3000); // Wait for new data to load
                pageNumber++;
            } catch (error) {
                console.log('Could not click next button:', error.message);
                break;
            }
            
            // Safety limit
            if (pageNumber > 10) {
                console.log('Reached safety limit of 10 pages');
                break;
            }
        }
        
        console.log('Total available dates found:', allAvailableDates);
        
        // Read previous state to detect NEW availability
        const fs = require('fs');
        let previousState = [];
        try {
            const stateData = fs.readFileSync('previous-state.json', 'utf8');
            previousState = JSON.parse(stateData);
            console.log('Loaded previous state:', previousState);
        } catch (error) {
            console.log('No previous state found (first run)');
        }
        
        // Find NEW available dates (not in previous state)
        const newAvailability = allAvailableDates.filter(current => {
            return !previousState.some(prev => 
                prev.equipment === current.equipment && prev.date === current.date
            );
        });
        
        console.log('New availability detected:', newAvailability);
        
        // Save current state for next run
        try {
            fs.writeFileSync('previous-state.json', JSON.stringify(allAvailableDates, null, 2));
            console.log('Saved current state');
        } catch (error) {
            console.error('Error saving state:', error);
        }
        
        // Only generate output if there's NEW availability (or first run)
        const isFirstRun = previousState.length === 0;
        const hasNewAvailability = newAvailability.length > 0;
        
        // Format results grouped by date
        let message;
        if (allAvailableDates.length === 0) {
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

❌ None available

No available overnight printing slots (last hour of the day) found over the next 14 days.

Check again tomorrow or visit: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        } else if (hasNewAvailability || isFirstRun) {
            // Group by date
            const byDate = {};
            const datesToShow = isFirstRun ? allAvailableDates : newAvailability;
            
            datesToShow.forEach(item => {
                if (!byDate[item.date]) {
                    byDate[item.date] = [];
                }
                byDate[item.date].push(item.equipment);
            });
            
            const dateList = Object.keys(byDate)
                .map(date => `${date}:\n    - ${byDate[date].join('\n    - ')}`)
                .join('\n\n  • ');
            
            const header = isFirstRun ? '✅ Currently Available' : '🆕 NEW Availability Detected!';
            
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

${header}

  • ${dateList}

Book now at: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        } else {
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

✓ No changes

Same availability as last check (${allAvailableDates.length} slots still available).
No action needed.
            `.trim();
        }
        
        console.log('\n' + message);
        
        // Write to GitHub Actions summary
        let summary;
        
        if (allAvailableDates.length > 0 && (hasNewAvailability || isFirstRun)) {
            // Group by date
            const byDate = {};
            const datesToShow = isFirstRun ? allAvailableDates : newAvailability;
            
            datesToShow.forEach(item => {
                if (!byDate[item.date]) {
                    byDate[item.date] = [];
                }
                byDate[item.date].push(item.equipment);
            });
            
            const dateLines = Object.keys(byDate)
                .map(date => `- **${date}**\n${byDate[date].map(eq => `  - ${eq}`).join('\n')}`)
                .join('\n');
            
            const header = isFirstRun ? 'Currently Available' : '🆕 NEW Availability Detected!';
            
            summary = `# 3D Printer Overnight Availability\n\n## ${header}\n\n${dateLines}\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        } else if (allAvailableDates.length === 0) {
            summary = `# 3D Printer Overnight Availability\n\n## ❌ None Available\n\nNo overnight printing slots found for the next 14 days.\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        } else {
            summary = `# 3D Printer Overnight Availability\n\n## ✓ No Changes\n\nSame availability as last check (${allAvailableDates.length} slots still available).\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        }
        
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || 'summary.md', summary);
        
        return { success: true, availableDates: allAvailableDates, message };
        
    } catch (error) {
        console.error('Error checking availability:', error);
        try {
            await page.screenshot({ path: 'error.png', fullPage: true });
            console.log('Error screenshot saved');
        } catch (screenshotError) {
            console.error('Could not take screenshot:', screenshotError);
        }
        throw error;
    } finally {
        await browser.close();
    }
}

checkAvailability().catch(error => {
    console.error('Failed:', error);
    process.exit(1);
});
