import xarray as xr
from zarr.codecs import ZstdCodec

ds = xr.open_dataset('./GRC_025gw.nc')
ds['lwe_thickness_anomaly'] = (ds['lwe_thickness'] - ds['lwe_thickness'].mean(dim='time')).round(3)
ds['lwe_thickness'] = ds['lwe_thickness'].round(3)
ds['uncertainty'] = ds['uncertainty'].round(3)
ds.to_netcdf('./GRC_025gw_anomaly.nc')
(
    ds
    .chunk({
        'time': ds['time'].shape[0],
        'lat': 16,
        'lon': 16,
    })
    .to_zarr(
        './grace025gwanomaly.zarr3',
        mode='w',
        zarr_version=3,
        encoding={
            'lwe_thickness_anomaly': {'compressors': ZstdCodec(level=5)},
            'lwe_thickness': {'compressors': ZstdCodec(level=5)},
            'uncertainty': {'compressors': ZstdCodec(level=5)},
        }
    )
)
