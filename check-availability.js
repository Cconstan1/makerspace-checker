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
            
            // Check for "end of bookable window" message
            const endMessage = await page.evaluate(() => {
                const body = document.body.textContent;
                return body.includes('You have reached the end of the bookable window');
            });
            
            if (endMessage) {
                console.log('Reached end of bookable window message');
            }
            
            // Extract availability from current page
            const availableDates = await page.evaluate(() => {
                const results = [];
                
                // Find the main schedule table
                const table = document.querySelector('table.fc-scrollgrid, table');
                if (!table) return results;
                
                // Get all header rows from thead
                const thead = table.querySelector('thead');
                if (!thead) return results;
                
                const headerRows = Array.from(thead.querySelectorAll('tr'));
                
                // First header row should have dates
                let dateRow = null;
                let timeRow = null;
                
                // Try to find the row with dates and the row with times
                for (const row of headerRows) {
                    const firstTh = row.querySelector('th');
                    if (firstTh) {
                        const text = firstTh.textContent.trim();
                        // Date headers typically have day names or dates
                        if (text.includes('day') || text.match(/\d{1,2}:\d{2}/)) {
                            if (!dateRow && (text.includes('Monday') || text.includes('Tuesday') || 
                                text.includes('Wednesday') || text.includes('Thursday') || 
                                text.includes('Friday') || text.includes('Saturday') || 
                                text.includes('Sunday'))) {
                                dateRow = row;
                            } else if (!timeRow && text.match(/\d{1,2}:\d{2}/)) {
                                timeRow = row;
                            }
                        }
                    }
                }
                
                // If we can't find proper headers, try alternative structure
                if (!dateRow) {
                    // Look for date information in data attributes or elsewhere
                    dateRow = headerRows.find(row => {
                        const ths = row.querySelectorAll('th');
                        return Array.from(ths).some(th => 
                            th.getAttribute('data-date') || 
                            th.textContent.includes('January') ||
                            th.textContent.includes('February')
                        );
                    });
                }
                
                if (!dateRow) {
                    console.log('Could not find date row');
                    return results;
                }
                
                const dateHeaders = Array.from(dateRow.querySelectorAll('th'));
                
                // Get time headers if available
                let timeHeaders = [];
                if (timeRow) {
                    timeHeaders = Array.from(timeRow.querySelectorAll('th'));
                }
                
                // Find tbody with equipment rows
                const tbody = table.querySelector('tbody');
                if (!tbody) return results;
                
                const rows = Array.from(tbody.querySelectorAll('tr'));
                
                for (const row of rows) {
                    const cells = Array.from(row.querySelectorAll('td, th'));
                    if (cells.length === 0) continue;
                    
                    const firstCell = cells[0];
                    
                    // Check if this is a 3D Printer row
                    if (firstCell && (firstCell.textContent.includes('Apple Mac Studio w/ Epson 12000XL 2D Scanner') || 
                                      firstCell.textContent.includes('Vinyl Cutter & Heat Press w/PC'))) {
                        console.log('Found 3D Printer row');
                        
                        // Get all time slot cells (skip the first cell which is equipment name)
                        const timeCells = cells.slice(1);
                        
                        // Try to determine how many cells per day
                        // Typically 24 hours per day
                        const cellsPerDay = 24;
                        
                        // Calculate number of days shown
                        const numDays = Math.floor(timeCells.length / cellsPerDay);
                        console.log(`Processing ${numDays} days with ${timeCells.length} total cells`);
                        
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
                                    break;
                                }
                            }
                            
                            if (lastBookableSlot) {
                                const { cell, cellIndex, link } = lastBookableSlot;
                                
                                // Check if this slot is available (green)
                                const hasAvailableClass = cell.classList.contains('s-lc-eq-checkout-available') ||
                                                         cell.querySelector('.s-lc-eq-available');
                                const isNotDisabled = !link.classList.contains('disabled');
                                const isNotReserved = !cell.classList.contains('s-lc-eq-checkout-reserved') &&
                                                     !cell.classList.contains('s-lc-eq-checkout-unavailable') &&
                                                     !cell.classList.contains('s-lc-eq-checkout-disabled');
                                
                                const isAvailable = hasAvailableClass && isNotDisabled && isNotReserved;
                                
                                console.log(`Day ${dayIndex}: Last bookable slot at index ${cellIndex}, available: ${isAvailable}`);
                                
                                if (isAvailable) {
                                    // Get the date for this day
                                    let dateText = 'Unknown Date';
                                    
                                    // dateHeaders[0] might be equipment column, so dates start at index 1
                                    // But we need to map dayIndex to the correct header
                                    const dateHeaderIdx = dayIndex + 1;
                                    if (dateHeaders[dateHeaderIdx]) {
                                        dateText = dateHeaders[dateHeaderIdx].textContent.trim();
                                    }
                                    
                                    // Try to get date from data attribute
                                    const dataDate = cell.getAttribute('data-date');
                                    if (dataDate && dateText === 'Unknown Date') {
                                        dateText = dataDate;
                                    }
                                    
                                    // Try to get time
                                    let timeText = '';
                                    const globalCellIdx = dayStartIdx + cellIndex + 1; // +1 for equipment column
                                    if (timeHeaders[globalCellIdx]) {
                                        timeText = timeHeaders[globalCellIdx].textContent.trim();
                                    }
                                    
                                    results.push({
                                        date: dateText,
                                        time: timeText || `Hour ${cellIndex}`,
                                        dayIndex: dayIndex
                                    });
                                }
                            }
                        }
                    }
                }
                
                return results;
            });
            
            console.log(`Page ${pageNumber} found:`, availableDates);
            allAvailableDates.push(...availableDates);
            
            // Check if next button is disabled
            const nextButtonDisabled = await page.evaluate(() => {
                const nextBtn = document.querySelector('button.fc-next-button');
                return nextBtn ? nextBtn.disabled : true;
            });
            
            if (nextButtonDisabled || endMessage) {
                console.log('Next button disabled or reached end');
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
