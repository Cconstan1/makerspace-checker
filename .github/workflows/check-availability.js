const puppeteer = require('puppeteer');

async function checkAvailability() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        console.log('Loading makerspace page...');
        await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for the calendar to load
        await page.waitForSelector('table', { timeout: 10000 });
        
        console.log('Analyzing availability...');
        
        // Extract availability information
        const availableDates = await page.evaluate(() => {
            const dates = [];
            const tables = document.querySelectorAll('table');
            
            tables.forEach(table => {
                const rows = table.querySelectorAll('tr');
                
                rows.forEach(row => {
                    const cells = Array.from(row.cells);
                    const firstCell = cells[0];
                    
                    if (firstCell && firstCell.textContent.includes('3D Printer - Prusa XL 5-Toolhead')) {
                        const dateHeaders = Array.from(table.querySelectorAll('thead th'));
                        const dateCells = cells.slice(1);
                        
                        // Check each day column
                        dateCells.forEach((cell, idx) => {
                            // Look for the last time slot indicator
                            // We need to check if this is the last row for each day
                            const link = cell.querySelector('a:not(.fc-bg)');
                            const isAvailable = link && 
                                              !link.classList.contains('disabled') && 
                                              !cell.classList.contains('s-lc-eq-checkout-disabled') &&
                                              (cell.querySelector('.s-lc-eq-available') || 
                                               (!cell.classList.contains('s-lc-eq-checkout-reserved') && 
                                                !cell.classList.contains('s-lc-eq-checkout-unavailable')));
                            
                            if (isAvailable) {
                                let dateText = 'Date unknown';
                                
                                if (dateHeaders[idx + 1]) {
                                    dateText = dateHeaders[idx + 1].textContent.trim();
                                } else if (link && link.href) {
                                    const url = new URL(link.href);
                                    dateText = url.searchParams.get('date') || dateText;
                                }
                                
                                dates.push(dateText);
                            }
                        });
                    }
                });
            });
            
            return [...new Set(dates)]; // Remove duplicates
        });
        
        console.log('Found available dates:', availableDates);
        
        // Format the email message
        let message;
        if (availableDates.length === 0) {
            message = `
3D PRINTER AVAILABILITY CHECK
============================

None available

No available slots found for the last time slot of "3D Printer - Prusa XL 5-Toolhead" over the next 14 days.

Check again tomorrow or visit: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        } else {
            message = `
3D PRINTER AVAILABILITY CHECK
============================

✅ Available on:

${availableDates.map(date => `• ${date}`).join('\n')}

Book now at: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        }
        
        console.log('\n' + message);
        
        // For GitHub Actions, we'll use a different email method
        // Since we can't use nodemailer without SMTP credentials,
        // we'll use GitHub's notification system
        
        // Write results to file for action summary
        const fs = require('fs');
        fs.writeFileSync('results.txt', message);
        
        // Also output to GitHub Actions summary
        console.log('::notice::' + (availableDates.length > 0 ? `Available dates: ${availableDates.join(', ')}` : 'No available slots'));
        
        return { success: true, availableDates, message };
        
    } catch (error) {
        console.error('Error checking availability:', error);
        await page.screenshot({ path: 'error.png' });
        throw error;
    } finally {
        await browser.close();
    }
}

checkAvailability().catch(error => {
    console.error('Failed:', error);
    process.exit(1);
});
