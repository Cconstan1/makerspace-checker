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
        
        // Wait for the calendar to load
        await page.waitForSelector('table', { timeout: 10000 });
        await delay(3000); // Extra wait for dynamic content
        
        console.log('Starting to check all pages...');
        
        const allAvailableDates = [];
        let pageNumber = 1;
        
        while (true) {
            console.log(`Checking page ${pageNumber}...`);
            
            // Extract availability from current page
            const availableDates = await page.evaluate(() => {
                const results = [];
                
                console.log('=== Starting page evaluation ===');
                
                // Find the main schedule table
                const table = document.querySelector('table.fc-scrollgrid, table');
                if (!table) {
                    console.log('ERROR: No table found!');
                    return results;
                }
                console.log('Found table');
                
                // Find tbody with equipment rows
                const tbody = table.querySelector('tbody');
                if (!tbody) {
                    console.log('ERROR: No tbody found!');
                    return results;
                }
                
                const rows = Array.from(tbody.querySelectorAll('tr'));
                console.log(`Found ${rows.length} rows in tbody`);
                
                for (const row of rows) {
                    const cells = Array.from(row.querySelectorAll('td, th'));
                    if (cells.length === 0) continue;
                    
                    const firstCell = cells[0];
                    const equipmentName = firstCell ? firstCell.textContent.trim() : '';
                    
                    // Check if this is one of our target equipment
                    const isTargetEquipment = equipmentName.includes('Apple Mac Studio w/ Epson 12000XL 2D Scanner') || 
                                             equipmentName.includes('Vinyl Cutter & Heat Press w/PC');
                    
                    if (isTargetEquipment) {
                        console.log(`✓ Found target equipment: ${equipmentName}`);
                        console.log(`  Row has ${cells.length} cells`);
                        
                        // Get all time slot cells (skip the first cell which is equipment name)
                        const timeCells = cells.slice(1);
                        console.log(`  Checking ${timeCells.length} time slot cells`);
                        
                        // Try to determine how many cells per day
                        const cellsPerDay = 24;
                        const numDays = Math.floor(timeCells.length / cellsPerDay);
                        console.log(`  Calculated ${numDays} days (${cellsPerDay} cells per day)`);
                        
                        for (let dayIndex = 0; dayIndex < numDays; dayIndex++) {
                            const dayStartIdx = dayIndex * cellsPerDay;
                            const dayEndIdx = Math.min(dayStartIdx + cellsPerDay, timeCells.length);
                            const dayCells = timeCells.slice(dayStartIdx, dayEndIdx);
                            
                            // Find the last bookable cell for this day (search backwards)
                            let lastBookableSlot = null;
                            
                            for (let i = dayCells.length - 1; i >= 0; i--) {
                                const cell = dayCells[i];
                                const link = cell.querySelector('a');
                                
                                // Check if this cell has a booking link (is bookable)
                                if (link && link.href && link.href.includes('reserve')) {
                                    lastBookableSlot = { cell, cellIndex: i, link };
                                    console.log(`  Day ${dayIndex}: Last bookable slot at index ${i}`);
                                    break;
                                }
                            }
                            
                            if (lastBookableSlot) {
                                const { cell, cellIndex, link } = lastBookableSlot;
                                
                                // Check if this slot is available (green)
                                const cellClasses = cell.className;
                                const hasAvailableClass = cell.classList.contains('s-lc-eq-checkout-available') ||
                                                         cell.querySelector('.s-lc-eq-available');
                                const isNotDisabled = !link.classList.contains('disabled');
                                const isNotReserved = !cell.classList.contains('s-lc-eq-checkout-reserved') &&
                                                     !cell.classList.contains('s-lc-eq-checkout-unavailable') &&
                                                     !cell.classList.contains('s-lc-eq-checkout-disabled');
                                
                                const isAvailable = hasAvailableClass && isNotDisabled && isNotReserved;
                                
                                console.log(`  Day ${dayIndex} availability check:`);
                                console.log(`    Cell classes: ${cellClasses}`);
                                console.log(`    hasAvailableClass: ${hasAvailableClass}`);
                                console.log(`    isNotDisabled: ${isNotDisabled}`);
                                console.log(`    isNotReserved: ${isNotReserved}`);
                                console.log(`    Final result: ${isAvailable}`);
                                
                                if (isAvailable) {
                                    results.push({
                                        date: `Day ${dayIndex}`,
                                        time: `Cell ${cellIndex}`,
                                        dayIndex: dayIndex,
                                        equipment: equipmentName
                                    });
                                }
                            } else {
                                console.log(`  Day ${dayIndex}: No bookable slots found`);
                            }
                        }
                    }
                }
                
                console.log(`=== Page evaluation complete. Found ${results.length} available slots ===`);
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
        
        // Format results
        let message;
        if (allAvailableDates.length === 0) {
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

❌ None available

No available overnight printing slots (last hour of the day) found for "3D Printer - Prusa XL 5-Toolhead" over the next 14 days.

Check again tomorrow or visit: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        } else {
            const dateList = allAvailableDates
                .map(item => `${item.date}${item.time ? ' at ' + item.time : ''}`)
                .join('\n  • ');
            
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

✅ Available overnight printing slots (last hour):

  • ${dateList}

Book now at: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        }
        
        console.log('\n' + message);
        
        // Write to GitHub Actions summary
        const fs = require('fs');
        let summary;
        
        if (allAvailableDates.length > 0) {
            const dateLines = allAvailableDates
                .map(item => `- **${item.date}**${item.time ? ' at ' + item.time : ''}`)
                .join('\n');
            
            summary = `# 3D Printer Overnight Availability\n\n## ✅ Available Dates\n\n${dateLines}\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        } else {
            summary = `# 3D Printer Overnight Availability\n\n## ❌ None Available\n\nNo overnight printing slots found for the next 14 days.\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        }
        
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || 'summary.md', summary);
        
        return { success: true, availableDates: allAvailableDates, message };
        
    } catch (error) {
        console.error('Error checking availability:', error);
        try {
            await page.screenshot({ path: 'error.png', fullPage: true });
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
