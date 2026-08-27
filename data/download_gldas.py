import requests
import datetime
import os
from dateutil import relativedelta

root_data_path = "/Users/rchales/data/groundwater/gldas"
today = datetime.date.today()

# Need complete months, gldas is 2-3 month lag, force date to the first (1 month) - 2 months (3 total)
# could add a check that the file size is at least 1MB and warn about those files
barrier_date = datetime.date(today.year, today.month, 1) - relativedelta.relativedelta(months=2)

def expected_url(model, year, month):
    directory = expected_directory_name(model)
    file_name = expected_file_name(model, year, month)
    return f"https://data.gesdisc.earthdata.nasa.gov/data/GLDAS/{directory}/{year}/{file_name}"

def expected_directory_name(model):
    return f"GLDAS_{model}_M.2.1"

def expected_file_name(model, year, month):
    return f"GLDAS_{model}_M.A{year}{month:02d}.021.nc4"

def expected_save_path(model, year, month):
    directory = expected_directory_name(model)
    file_name = expected_file_name(model, year, month)
    return os.path.join(root_data_path, directory, str(year), file_name)

downloads = []  # tuples of type (url: str, save_path: str)
for model in ["NOAH025", "VIC10", "CLSM10"]:
    for year in range(2002, 2027):
        for month in range(1, 13):
            if datetime.date(year, month, 1) >= barrier_date:
                continue
            save_path = expected_save_path(model, year, month)
            if os.path.exists(save_path):
                continue
            url = expected_url(model, year, month)
            downloads.append((url, save_path))

print(len(downloads))
for download in downloads:
    url, save_path = download
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    print("Downloading")
    print(f"\tURL: {url}")
    print(f"\tSave Path: {save_path}")
    response = requests.get(url)
    if response.status_code == 200:
        with open(save_path, 'wb') as f:
            f.write(response.content)
        print(f"Downloaded {url} to {save_path}.")
    else:
        print(f"Failed to download {url}. Status code: {response.status_code}")
