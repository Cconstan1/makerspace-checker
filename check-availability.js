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
                
                // Find ALL links on the page and log them to understand the structure
                const allLinks = document.querySelectorAll('a');
                console.log(`Total links on page: ${allLinks.length}`);
                
                // Look specifically for equipment links - they're in the "Space" column
                const equipmentLinks = [];
                allLinks.forEach(link => {
                    const text = link.textContent.trim();
                    if (text.includes('3D Printer') || text.includes('Apple Mac') || 
                        text.includes('Vinyl Cutter') || text.includes('Laser Cutter') ||
                        text.includes('CNC Router') || text.includes('Sewing Machine')) {
                        equipmentLinks.push(link);
                        console.log(`Found equipment link: "${text}"`);
                    }
                });
                
                console.log(`Found ${equipmentLinks.length} equipment links`);
                
                for (const link of equipmentLinks) {
                    const equipmentName = link.textContent.trim();
                    
                    // Check if this is one of our target equipment
                    const isTargetEquipment = equipmentName.includes('Apple Mac Studio w/ Epson 12000XL 2D Scanner') || 
                                             equipmentName.includes('Vinyl Cutter & Heat Press w/PC');
                    
                    if (isTargetEquipment) {
                        console.log(`✓ Found target equipment: ${equipmentName}`);
                        
                        // Find the parent row/container for this equipment
                        let row = link.closest('tr');
                        if (!row) {
                            console.log('  Trying to find parent div...');
                            row = link.closest('div[class*="row"]');
                        }
                        
                        if (!row) {
                            console.log('  Could not find parent row');
                            continue;
                        }
                        
                        console.log(`  Found parent row with tag: ${row.tagName}`);
                        
                        // Find all time slot cells/divs in this row
                        const cells = row.querySelectorAll('td');
                        console.log(`  Found ${cells.length} td cells in row`);
                        
                        // Get the table to find date headers
                        const table = row.closest('table');
                        let dateHeaders = [];
                        if (table) {
                            // Look for header rows with dates
                            const headerRows = table.querySelectorAll('thead tr');
                            headerRows.forEach(headerRow => {
                                const headers = headerRow.querySelectorAll('th');
                                headers.forEach(h => {
                                    const text = h.textContent.trim();
                                    if (text.includes('day') || text.includes('January') || text.includes('February')) {
                                        dateHeaders.push(text);
                                    }
                                });
                            });
                            console.log(`  Found ${dateHeaders.length} date headers`);
                        }
                        
                        if (cells.length === 0) {
                            // Maybe it's divs instead
                            const divCells = row.querySelectorAll('div[class*="cell"], div[class*="slot"]');
                            console.log(`  Found ${divCells.length} div cells in row`);
                        }
                        
                        // Search backwards from the end to find the last bookable slot
                        for (let i = cells.length - 1; i >= 0; i--) {
                            const cell = cells[i];
                            const cellLink = cell.querySelector('a');
                            
                            if (cellLink) {
                                // This is a bookable slot
                                console.log(`  Found bookable slot at cell ${i}`);
                                console.log(`  Cell link href: ${cellLink.href}`);
                                console.log(`  Cell classes: ${cell.className}`);
                                
                                // Check if it's available
                                const hasGreenClass = cell.className.includes('available') || 
                                                     cell.className.includes('green');
                                const hasRedClass = cell.className.includes('reserved') || 
                                                   cell.className.includes('unavailable') ||
                                                   cell.className.includes('disabled');
                                
                                const isAvailable = !hasRedClass;
                                
                                console.log(`  hasGreenClass: ${hasGreenClass}, hasRedClass: ${hasRedClass}, isAvailable: ${isAvailable}`);
                                
                                if (isAvailable) {
                                    // Try to get the date from the link URL first (most reliable)
                                    let dateText = 'Unknown Date';
                                    
                                    if (cellLink.href) {
                                        try {
                                            const url = new URL(cellLink.href);
                                            const urlDate = url.searchParams.get('date');
                                            if (urlDate) {
                                                dateText = urlDate;
                                                console.log(`  Extracted date from URL: ${dateText}`);
                                            }
                                        } catch (e) {
                                            console.log(`  Error parsing URL: ${e.message}`);
                                        }
                                    }
                                    
                                    // Fallback: try to get from column header
                                    if (dateText === 'Unknown Date' && dateHeaders.length > 0) {
                                        // Try different header indices
                                        const possibleIndices = [i, i-1, Math.floor(i/2)];
                                        for (const idx of possibleIndices) {
                                            if (dateHeaders[idx]) {
                                                dateText = dateHeaders[idx];
                                                console.log(`  Got date from header index ${idx}: ${dateText}`);
                                                break;
                                            }
                                        }
                                    }
                                    
                                    // Fallback: try data attributes
                                    if (dateText === 'Unknown Date') {
                                        const dataDate = cell.getAttribute('data-date');
                                        if (dataDate) {
                                            dateText = dataDate;
                                            console.log(`  Got date from data-date attribute: ${dateText}`);
                                        }
                                    }
                                    
                                    console.log(`  Final date: ${dateText}`);
                                    
                                    results.push({
                                        equipment: equipmentName,
                                        date: dateText,
                                        cellIndex: i
                                    });
                                }
                                
                                // Only check the last bookable slot
                                break;
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
                .map(item => `${item.equipment}: ${item.date}`)
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
                .map(item => `- **${item.equipment}**: ${item.date}`)
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
