export function toTimezoneDateString(dateInput: Date | string, timeZone: string): string {
    const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    return `${year}-${month}-${day}`;
}

export function getTimezoneUtcRange(dateStr: string, timeZone: string): { startUtc: string; nextDayStartUtc: string } {
    const [y, m, d] = dateStr.split('-').map(Number);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
    });

    const testDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const parts = formatter.formatToParts(testDate);
    const tzYear = Number(parts.find((p) => p.type === 'year')?.value);
    const tzMonth = Number(parts.find((p) => p.type === 'month')?.value);
    const tzDay = Number(parts.find((p) => p.type === 'day')?.value);
    let tzHour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (tzHour === 24) tzHour = 0;
    const tzMin = Number(parts.find((p) => p.type === 'minute')?.value);

    const tzTimeAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, 0);
    const offsetMs = tzTimeAsUtc - testDate.getTime();

    const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
    const nextDayUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

    return {
        startUtc: new Date(startUtcMs).toISOString(),
        nextDayStartUtc: new Date(nextDayUtcMs).toISOString(),
    };
}
