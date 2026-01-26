import xarray as xr
from zarr.codecs import ZstdCodec

ds = xr.open_dataset('./GRC_gw.nc')
ds['lwe_thickness_anomaly'] = ds['lwe_thickness'] - ds['lwe_thickness'].mean(dim='time')
ds.to_netcdf('/Users/rchales/data/grace/GRC_gw_anomaly.nc')
(
    ds
    # for 1 degree tiles
    .chunk({
        'time': 199,
        'lat': 2,
        'lon': 2,
    })
    .to_zarr(
        './GRC_gw_anomaly.zarr',
        mode='w',
        zarr_version=3,
        encoding={'lwe_thickness_anomaly': {'compressors': ZstdCodec(level=5)}}
    )
)
